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
import type { LockEntryContent } from './types.ts'

type AcquireMethod = 'acquire' | 'acquireImmediately'
type MethodPatch = {
  target: Record<PropertyKey, unknown>
  method: string
  descriptor?: PropertyDescriptor
  wrapper: (...args: unknown[]) => unknown
}
type LockContainer = {
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

function serializedKey(value: unknown): string | undefined {
  const serialized = safeSerialize(value)
  return typeof serialized === 'string' && serialized !== '' ? serialized : undefined
}

function isTimeoutError(error: unknown): boolean {
  for (const field of ['code', 'name', 'message'] as const) {
    const value = readField(error, field)
    if (typeof value === 'string' && value.toLowerCase().includes('timeout')) return true
  }
  return false
}

/**
 * Observes the optional @adonisjs/lock service structurally. Its provider registers `lock.manager`
 * as a Verrou instance; Verrou.createLock(name, ttl) returns a Lock. Verrou Lock.acquire and
 * acquireImmediately return false when denied (including retry timeout), while run and
 * runImmediately delegate to those methods. TTL is resolved to milliseconds by LockFactory.
 * Sources: adonisjs/lock providers/lock_provider.ts and Julien-R44/verrou
 * packages/verrou/src/{verrou,lock_factory,lock}.ts.
 */
export class LockWatcher implements Watcher {
  readonly name = WatcherName.LOCK
  readonly stats = { recorded: 0, patched: 0 }

  readonly #context: WatcherContext
  readonly #patches: MethodPatch[] = []
  readonly #acquisitionScope = new AsyncLocalStorage<boolean>()
  #active = false

  constructor(context: WatcherContext) {
    this.#context = context
  }

  async register(): Promise<void> {
    if (this.#active || !this.#context.config.watchers.lock.enabled) return

    await safeguardAsync('periscope.watcher.lock.register', async () => {
      const container = this.#context.app.container as unknown as LockContainer
      if (!container.hasBinding('lock.manager')) return

      const manager = await container.make('lock.manager')
      if (
        !isObject(manager) ||
        (typeof readField(manager, 'createLock') !== 'function' &&
          typeof readField(manager, 'use') !== 'function')
      ) {
        return
      }

      this.#active = true
      try {
        this.#patchFactory(manager)
        this.#patchUse(manager)
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
      safeguard('periscope.watcher.lock.restore', () => {
        if (readField(patch.target, patch.method) !== patch.wrapper) return
        if (patch.descriptor === undefined) Reflect.deleteProperty(patch.target, patch.method)
        else Object.defineProperty(patch.target, patch.method, patch.descriptor)
      })
    }
  }

  #patchUse(manager: Record<PropertyKey, unknown>): void {
    if (this.#patches.some((patch) => patch.target === manager && patch.method === 'use')) return
    const original = readField(manager, 'use')
    if (typeof original !== 'function') return

    const descriptor = Object.getOwnPropertyDescriptor(manager, 'use')
    const watcher = this
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const factory = Reflect.apply(original, this, args)
      safeguard('periscope.watcher.lock.use', () => {
        if (isObject(factory)) watcher.#patchFactory(factory)
      })
      return factory
    }
    this.#install(manager, 'use', descriptor, wrapper)
  }

  #patchFactory(factory: Record<PropertyKey, unknown>): void {
    if (this.#patches.some((patch) => patch.target === factory && patch.method === 'createLock')) {
      return
    }
    const original = readField(factory, 'createLock')
    if (typeof original !== 'function') return

    const descriptor = Object.getOwnPropertyDescriptor(factory, 'createLock')
    const watcher = this
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const lock = Reflect.apply(original, this, args)
      safeguard('periscope.watcher.lock.createLock', () =>
        watcher.#patchLock(lock, args[0], args[1])
      )
      return lock
    }
    this.#install(factory, 'createLock', descriptor, wrapper)
  }

  #patchLock(value: unknown, rawKey: unknown, rawTtl: unknown): void {
    if (!isObject(value)) return
    const key = serializedKey(rawKey)
    if (key === undefined) return

    const methods: AcquireMethod[] = ['acquire', 'acquireImmediately']
    if (!methods.some((method) => typeof readField(value, method) === 'function')) return
    let ttlMs = typeof rawTtl === 'number' && Number.isFinite(rawTtl) ? rawTtl : undefined
    const serialize = readField(value, 'serialize')
    if (ttlMs === undefined && typeof serialize === 'function') {
      const serialized = Reflect.apply(serialize, value, [])
      const resolvedTtl = readField(serialized, 'ttl')
      if (typeof resolvedTtl === 'number' && Number.isFinite(resolvedTtl)) ttlMs = resolvedTtl
    }
    for (const method of methods) this.#patchAcquire(value, method, key, ttlMs)
  }

  #patchAcquire(
    target: Record<PropertyKey, unknown>,
    method: AcquireMethod,
    key: string,
    ttlMs: number | undefined
  ): void {
    if (this.#patches.some((patch) => patch.target === target && patch.method === method)) return
    const original = readField(target, method)
    if (typeof original !== 'function') return

    const descriptor = Object.getOwnPropertyDescriptor(target, method)
    const watcher = this
    const wrapper = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      if (watcher.#acquisitionScope.getStore()) {
        return Reflect.apply(original, this, args)
      }

      return watcher.#acquisitionScope.run(true, async () => {
        const startedAt = process.hrtime.bigint()
        try {
          const result = await Reflect.apply(original, this, args)
          const waitedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
          await safeguardAsync(`periscope.watcher.lock.${method}`, async () => {
            if (result === false) watcher.#record(key, 'denied', waitedMs, ttlMs)
            else if (
              result === true &&
              waitedMs >= watcher.#context.config.watchers.lock.contentionMs
            ) {
              watcher.#record(key, 'acquired', waitedMs, ttlMs)
            }
          })
          return result
        } catch (error) {
          const waitedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
          await safeguardAsync(`periscope.watcher.lock.${method}`, async () => {
            watcher.#record(key, isTimeoutError(error) ? 'timeout' : 'denied', waitedMs, ttlMs)
          })
          throw error
        }
      })
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

  #record(
    key: string,
    action: LockEntryContent['action'],
    waitedMs: number,
    ttlMs: number | undefined
  ): void {
    if (!this.#active) return
    const content: LockEntryContent = {
      key,
      action,
      waitedMs,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    }
    const entry = IncomingEntry.make(EntryType.LOCK, content).withTags(
      `key:${key}`,
      action,
      action === 'acquired' ? 'contention' : undefined
    )
    this.#context.recorder.record(entry)
    this.stats.recorded++
  }
}
