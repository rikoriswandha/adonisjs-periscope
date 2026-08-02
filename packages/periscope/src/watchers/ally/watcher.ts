/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { IncomingEntry } from '../../entry.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard, safeguardAsync } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { AllyEntryContent } from './types.ts'

type AllyOperation = 'redirect' | 'redirectUrl' | 'user' | 'userFromToken' | 'accessToken'
type Patch = {
  target: Record<PropertyKey, unknown>
  method: string
  descriptor?: PropertyDescriptor
  wrapper: (...args: unknown[]) => unknown
}

const ALLY_OPERATIONS: readonly AllyOperation[] = [
  'redirect',
  'redirectUrl',
  'user',
  'userFromToken',
  'accessToken',
]

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

function identitySummary(user: unknown): unknown {
  if (!isObject(user)) return undefined

  const summary: Record<string, unknown> = {}
  for (const field of ['id', 'nickName', 'email'] as const) {
    const value = readField(user, field)
    if (
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean'
    ) {
      summary[field] = value
    }
  }

  return Object.keys(summary).length === 0 ? undefined : safeSerialize(summary)
}

/** Instruments request-scoped Ally drivers through the exported AllyManager prototype. */
export class AllyWatcher implements Watcher {
  readonly name = WatcherName.ALLY
  readonly stats = { recorded: 0, failed: 0 }

  readonly #context: WatcherContext
  readonly #patches: Patch[] = []
  #patchedDrivers = new WeakSet<object>()
  #active = false

  constructor(context: WatcherContext) {
    this.#context = context
  }

  async register(): Promise<void> {
    if (!this.#context.config.watchers.ally.enabled || this.#active) return

    await safeguardAsync('periscope.watcher.ally.register', async () => {
      // Ally is an optional peer, so importing it eagerly would make Periscope fail to load.
      const allyModule: unknown = await import('@adonisjs/ally')
      const AllyManager = readField(allyModule, 'AllyManager')
      const prototype = readField(AllyManager, 'prototype')
      if (!isObject(prototype)) return

      const original = readField(prototype, 'use')
      if (typeof original !== 'function') return

      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'use')
      const watcher = this
      const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        const driver = Reflect.apply(original, this, args)
        safeguard('periscope.watcher.ally.use', () => {
          const provider = typeof args[0] === 'string' ? args[0] : ''
          if (provider !== '') watcher.#patchDriver(driver, provider)
        })
        return driver
      }

      this.#definePatch(prototype, 'use', descriptor, wrapper)
      this.#active = true
    })
  }

  cleanup(): void {
    this.#active = false
    this.#patchedDrivers = new WeakSet<object>()
    for (const patch of this.#patches.splice(0).reverse()) {
      safeguard('periscope.watcher.ally.restore', () => {
        if (readField(patch.target, patch.method) !== patch.wrapper) return
        if (patch.descriptor === undefined) Reflect.deleteProperty(patch.target, patch.method)
        else Object.defineProperty(patch.target, patch.method, patch.descriptor)
      })
    }
  }

  #patchDriver(rawDriver: unknown, provider: string): void {
    if (!isObject(rawDriver) || this.#patchedDrivers.has(rawDriver)) return
    this.#patchedDrivers.add(rawDriver)

    for (const operation of ALLY_OPERATIONS) {
      const original = readField(rawDriver, operation)
      if (typeof original !== 'function') continue

      const descriptor = Object.getOwnPropertyDescriptor(rawDriver, operation)
      const watcher = this
      const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        const startedAt = performance.now()
        let result: unknown
        try {
          result = Reflect.apply(original, this, args)
        } catch (error) {
          watcher.#record(provider, operation, startedAt, undefined, error)
          throw error
        }

        const then = readField(result, 'then')
        if (typeof then !== 'function') {
          watcher.#record(provider, operation, startedAt, result)
          return result
        }

        return Promise.resolve(result).then(
          (value) => {
            watcher.#record(provider, operation, startedAt, value)
            return value
          },
          (error: unknown) => {
            watcher.#record(provider, operation, startedAt, undefined, error)
            throw error
          }
        )
      }

      this.#definePatch(rawDriver, operation, descriptor, wrapper)
    }
  }

  #definePatch(
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
  }

  #record(
    provider: string,
    operation: AllyOperation,
    startedAt: number,
    result?: unknown,
    error?: unknown
  ): void {
    safeguard(`periscope.watcher.ally.${operation}`, () => {
      if (!this.#active) return

      const user =
        operation === 'user' || operation === 'userFromToken' ? identitySummary(result) : undefined
      const content: AllyEntryContent = {
        provider,
        operation,
        durationMs: performance.now() - startedAt,
        ...(user === undefined ? {} : { user }),
        ...(error === undefined ? {} : { error: safeSerialize(error) }),
      }
      const entry = IncomingEntry.make(EntryType.ALLY, content).withTags(
        `provider:${provider}`,
        `op:${operation}`,
        error === undefined ? undefined : 'failed'
      )

      this.#context.recorder.record(entry)
      this.stats.recorded++
      if (error !== undefined) this.stats.failed++
    })
  }
}
