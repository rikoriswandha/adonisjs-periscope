/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { IncomingEntry } from '../../entry.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard, safeguardAsync } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { RateLimitEntryContent } from './types.ts'

type LimiterMethod = 'consume' | 'attempt' | 'penalize'
type MethodPatch = {
  target: Record<PropertyKey, unknown>
  method: string
  descriptor?: PropertyDescriptor
  wrapper: (...args: unknown[]) => unknown
}
type LimiterContainer = {
  hasBinding(binding: string): boolean
  make(binding: string): Promise<unknown>
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function readField(value: unknown, key: PropertyKey): unknown {
  if (!isObject(value)) return undefined
  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function serializedKey(value: unknown): string | undefined {
  const serialized = safeSerialize(value)
  if (typeof serialized === 'string') return serialized
  if (typeof serialized === 'number' && Number.isFinite(serialized)) return String(serialized)
  return undefined
}

function isThrottleError(error: unknown): boolean {
  const response = readField(error, 'response')
  return (
    readField(error, 'code') === 'E_TOO_MANY_REQUESTS' ||
    readField(error, 'status') === 429 ||
    (isObject(response) &&
      finiteNumber(readField(response, 'limit')) !== undefined &&
      finiteNumber(readField(response, 'remaining')) !== undefined)
  )
}

/**
 * Observes the optional @adonisjs/limiter service without importing it. Its provider registers
 * `limiter.manager`; LimiterManager.use returns a Limiter whose consume method throws
 * E_TOO_MANY_REQUESTS with a LimiterResponse (`limit`, `remaining`, `availableIn` seconds).
 * Sources: adonisjs/limiter providers/limiter_provider.ts, src/limiter_manager.ts,
 * src/limiter.ts, src/errors.ts, and src/response.ts.
 */
export class LimiterWatcher implements Watcher {
  readonly name = WatcherName.LIMITER
  readonly stats = { recorded: 0, patched: 0 }

  readonly #context: WatcherContext
  readonly #patches: MethodPatch[] = []
  readonly #attemptScope = new AsyncLocalStorage<{
    callbackStarted: boolean
    throttleError?: unknown
  }>()
  #active = false

  constructor(context: WatcherContext) {
    this.#context = context
  }

  async register(): Promise<void> {
    if (this.#active || !this.#context.config.watchers.limiter.enabled) return

    await safeguardAsync('periscope.watcher.limiter.register', async () => {
      const container = this.#context.app.container as unknown as LimiterContainer
      if (!container.hasBinding('limiter.manager')) return

      const manager = await container.make('limiter.manager')
      if (!isObject(manager) || typeof readField(manager, 'use') !== 'function') return

      this.#active = true
      try {
        this.#patchManager(manager)
        if (this.#patches.length === 0) this.#active = false
      } catch (error) {
        this.cleanup()
        throw error
      }
    })
  }

  cleanup(): void {
    this.#active = false
    for (const patch of this.#patches.splice(0).reverse()) {
      safeguard('periscope.watcher.limiter.restore', () => {
        if (readField(patch.target, patch.method) !== patch.wrapper) return
        if (patch.descriptor === undefined) Reflect.deleteProperty(patch.target, patch.method)
        else Object.defineProperty(patch.target, patch.method, patch.descriptor)
      })
    }
  }

  #patchManager(manager: Record<PropertyKey, unknown>): void {
    const original = readField(manager, 'use')
    if (typeof original !== 'function') return

    const descriptor = Object.getOwnPropertyDescriptor(manager, 'use')
    const watcher = this
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const limiter = Reflect.apply(original, this, args)
      safeguard('periscope.watcher.limiter.use', () => watcher.#patchLimiter(limiter))
      return limiter
    }

    this.#install(manager, 'use', descriptor, wrapper)
  }

  #patchLimiter(value: unknown): void {
    if (!isObject(value)) return

    const methods: LimiterMethod[] = ['consume', 'attempt', 'penalize']
    if (!methods.some((method) => typeof readField(value, method) === 'function')) return
    for (const method of methods) this.#patchLimiterMethod(value, method)
  }

  #patchLimiterMethod(target: Record<PropertyKey, unknown>, method: LimiterMethod): void {
    if (this.#patches.some((patch) => patch.target === target && patch.method === method)) return
    const original = readField(target, method)
    if (typeof original !== 'function') return

    const descriptor = Object.getOwnPropertyDescriptor(target, method)
    const watcher = this
    const wrapper = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const activeAttempt = watcher.#attemptScope.getStore()
      if (method === 'consume' && activeAttempt && !activeAttempt.callbackStarted) {
        try {
          return await Reflect.apply(original, this, args)
        } catch (error) {
          if (isThrottleError(error)) activeAttempt.throttleError = error
          throw error
        }
      }

      let callbackRan = false
      let callArgs = args
      const attempt: { callbackStarted: boolean; throttleError?: unknown } = {
        callbackStarted: false,
      }
      if (method === 'attempt' && typeof args[1] === 'function') {
        const callback = args[1]
        callArgs = [...args]
        callArgs[1] = function (this: unknown, ...callbackArgs: unknown[]): unknown {
          callbackRan = true
          attempt.callbackStarted = true
          return Reflect.apply(callback, this, callbackArgs)
        }
      }

      const invoke = async (): Promise<unknown> => {
        try {
          const result = await Reflect.apply(original, this, callArgs)
          await safeguardAsync(`periscope.watcher.limiter.${method}`, async () => {
            if (result === false) watcher.#record(target, args[0], method)
            if (method === 'attempt' && result === undefined && !callbackRan) {
              watcher.#record(target, args[0], method, attempt.throttleError)
            }
            if (
              method === 'penalize' &&
              Array.isArray(result) &&
              result.length >= 2 &&
              isThrottleError(result[0]) &&
              result[1] === null
            ) {
              watcher.#record(target, args[0], method, result[0])
            }
          })
          return result
        } catch (error) {
          await safeguardAsync(`periscope.watcher.limiter.${method}`, async () => {
            if (isThrottleError(error)) watcher.#record(target, args[0], method, error)
          })
          throw error
        }
      }

      return method === 'attempt' ? watcher.#attemptScope.run(attempt, invoke) : invoke()
    }

    this.#install(target, method, descriptor, wrapper)
  }

  #install(
    target: Record<PropertyKey, unknown>,
    method: string,
    descriptor: PropertyDescriptor | undefined,
    wrapper: (...args: unknown[]) => unknown
  ): void {
    if (descriptor === undefined) {
      Object.defineProperty(target, method, { configurable: true, writable: true, value: wrapper })
    } else {
      Object.defineProperty(target, method, { ...descriptor, value: wrapper })
    }
    this.#patches.push({ target, method, descriptor, wrapper })
    this.stats.patched++
  }

  #record(limiter: unknown, rawKey: unknown, action: string, error?: unknown): void {
    if (!this.#active) return
    const key = serializedKey(rawKey)
    if (key === undefined) return

    const response = readField(error, 'response')
    const limit =
      finiteNumber(readField(response, 'limit')) ?? finiteNumber(readField(limiter, 'requests'))
    const remaining = finiteNumber(readField(response, 'remaining'))
    const availableIn = finiteNumber(readField(response, 'availableIn'))
    const store = serializedKey(readField(limiter, 'name'))
    const content: RateLimitEntryContent = {
      key,
      action,
      ...(limit === undefined ? {} : { limit }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(availableIn === undefined ? {} : { retryAfterMs: availableIn * 1000 }),
      ...(store === undefined ? {} : { store }),
    }
    const entry = IncomingEntry.make(EntryType.RATE_LIMIT, content).withTags(
      `key:${key}`,
      'rejected'
    )
    this.#context.recorder.record(entry)
    this.stats.recorded++
  }
}
