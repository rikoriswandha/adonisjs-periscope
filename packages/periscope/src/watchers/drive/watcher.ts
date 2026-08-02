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
import type { DriveEntryContent } from './types.ts'

type DriveMethod =
  | 'put'
  | 'putStream'
  | 'get'
  | 'getStream'
  | 'getArrayBuffer'
  | 'getBytes'
  | 'delete'
  | 'deleteAll'
  | 'copy'
  | 'move'
  | 'exists'
  | 'getUrl'
  | 'getSignedUrl'
  | 'getMetaData'

type Patch = {
  target: Record<PropertyKey, unknown>
  method: string
  descriptor?: PropertyDescriptor
  wrapper: (...args: unknown[]) => unknown
}

type DriveContainer = {
  hasBinding(binding: string): boolean
  make(binding: string): Promise<unknown>
}

const DRIVE_METHODS: readonly DriveMethod[] = [
  'put',
  'putStream',
  'get',
  'getStream',
  'getArrayBuffer',
  'getBytes',
  'delete',
  'deleteAll',
  'copy',
  'move',
  'exists',
  'getUrl',
  'getSignedUrl',
  'getMetaData',
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

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return value.map((item) => stringValue(item)).join(',')
  return ''
}

function cheapSize(value: unknown): number | undefined {
  if (typeof value === 'string') return Buffer.byteLength(value)
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  return undefined
}

/** Instruments disks returned by the `drive.manager` singleton without retaining file contents. */
export class DriveWatcher implements Watcher {
  readonly name = WatcherName.DRIVE
  readonly stats = { recorded: 0, failed: 0 }

  readonly #context: WatcherContext
  readonly #patches: Patch[] = []
  #patchedDisks = new WeakSet<object>()
  #active = false

  constructor(context: WatcherContext) {
    this.#context = context
  }

  async register(): Promise<void> {
    if (!this.#context.config.watchers.drive.enabled || this.#active) return

    await safeguardAsync('periscope.watcher.drive.register', async () => {
      const container = this.#context.app.container as unknown as DriveContainer
      if (
        typeof container.hasBinding !== 'function' ||
        typeof container.make !== 'function' ||
        !container.hasBinding('drive.manager')
      ) {
        return
      }

      const manager = await container.make('drive.manager')
      if (!isObject(manager)) return

      const original = readField(manager, 'use')
      if (typeof original !== 'function') return

      const descriptor = Object.getOwnPropertyDescriptor(manager, 'use')
      const watcher = this
      const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        const disk = Reflect.apply(original, this, args)
        safeguard('periscope.watcher.drive.use', () => {
          watcher.#patchDisk(disk, typeof args[0] === 'string' ? args[0] : undefined)
        })
        return disk
      }

      this.#definePatch(manager, 'use', descriptor, wrapper)
      this.#active = true
    })
  }

  cleanup(): void {
    this.#active = false
    this.#patchedDisks = new WeakSet<object>()
    for (const patch of this.#patches.splice(0).reverse()) {
      safeguard('periscope.watcher.drive.restore', () => {
        if (readField(patch.target, patch.method) !== patch.wrapper) return
        if (patch.descriptor === undefined) Reflect.deleteProperty(patch.target, patch.method)
        else Object.defineProperty(patch.target, patch.method, patch.descriptor)
      })
    }
  }

  #patchDisk(rawDisk: unknown, diskName: string | undefined): void {
    if (!isObject(rawDisk) || this.#patchedDisks.has(rawDisk)) return
    this.#patchedDisks.add(rawDisk)

    for (const method of DRIVE_METHODS) {
      const original = readField(rawDisk, method)
      if (typeof original !== 'function') continue

      const descriptor = Object.getOwnPropertyDescriptor(rawDisk, method)
      const watcher = this
      const wrapper = function (this: unknown, ...args: unknown[]): unknown {
        const startedAt = performance.now()
        let result: unknown
        try {
          result = Reflect.apply(original, this, args)
        } catch (error) {
          watcher.#record(method, diskName, args, startedAt, error)
          throw error
        }

        const then = readField(result, 'then')
        if (typeof then !== 'function') {
          watcher.#record(method, diskName, args, startedAt)
          return result
        }

        return Promise.resolve(result).then(
          (value) => {
            watcher.#record(method, diskName, args, startedAt)
            return value
          },
          (error: unknown) => {
            watcher.#record(method, diskName, args, startedAt, error)
            throw error
          }
        )
      }

      this.#definePatch(rawDisk, method, descriptor, wrapper)
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
    operation: DriveMethod,
    disk: string | undefined,
    args: unknown[],
    startedAt: number,
    error?: unknown
  ): void {
    safeguard(`periscope.watcher.drive.${operation}`, () => {
      if (!this.#active) return
      const sizeBytes = operation === 'put' ? cheapSize(args[1]) : undefined

      const content: DriveEntryContent = {
        operation,
        key: stringValue(args[0]),
        durationMs: performance.now() - startedAt,
        ...(disk === undefined ? {} : { disk }),
        ...(operation === 'copy' || operation === 'move'
          ? { destination: stringValue(args[1]) }
          : {}),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        ...(error === undefined ? {} : { error: safeSerialize(error) }),
      }
      const entry = IncomingEntry.make(EntryType.DRIVE, content).withTags(
        `op:${operation}`,
        disk === undefined ? undefined : `disk:${disk}`,
        error === undefined ? undefined : 'failed'
      )

      this.#context.recorder.record(entry)
      this.stats.recorded++
      if (error !== undefined) this.stats.failed++
    })
  }
}
