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
import type { BroadcastEntryContent } from './types.ts'

type BroadcastMethod = 'broadcast' | 'broadcastExcept'

type MethodPatch = {
  target: Record<PropertyKey, unknown>
  method: BroadcastMethod
  descriptor?: PropertyDescriptor
  wrapper: (...args: unknown[]) => unknown
}

type TransmitContainer = {
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

function serializedString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const serialized = safeSerialize(value)
  return typeof serialized === 'string' && serialized !== '' ? serialized : undefined
}

/**
 * Observes @adonisjs/transmit through its documented `broadcast` lifecycle event.
 *
 * Transmit is an optional peer and augments the container only when its provider is installed, so
 * this watcher relies on the structural container binding instead of importing the package. The
 * method wrappers are a compatibility fallback for transmit-shaped services without lifecycle
 * events; they are installed on the resolved singleton and restored exactly during cleanup.
 */
export class TransmitWatcher implements Watcher {
  readonly name = WatcherName.TRANSMIT
  readonly stats = { recorded: 0 }

  readonly #context: WatcherContext
  readonly #patches: MethodPatch[] = []
  #unsubscribe?: () => void
  #active = false

  constructor(context: WatcherContext) {
    this.#context = context
  }

  readonly #handleBroadcast = (message: unknown): void => {
    safeguard('periscope.watcher.transmit.broadcast', () => {
      const payload = this.#context.config.watchers.transmit.capturePayload
        ? readField(message, 'payload')
        : undefined

      this.#record(readField(message, 'channel'), readField(message, 'event'), payload)
    })
  }

  async register(): Promise<void> {
    if (this.#active) return

    await safeguardAsync('periscope.watcher.transmit.register', async () => {
      const container = this.#context.app.container as unknown as TransmitContainer
      if (!container.hasBinding('transmit')) return

      const transmit = await container.make('transmit')
      if (!isObject(transmit)) return

      this.#active = true

      try {
        const on = readField(transmit, 'on')
        if (typeof on === 'function') {
          const unsubscribe = Reflect.apply(on, transmit, ['broadcast', this.#handleBroadcast])
          if (typeof unsubscribe === 'function') this.#unsubscribe = unsubscribe
          this.#patch(transmit, 'broadcastExcept')
          return
        }

        this.#patch(transmit, 'broadcast')
        this.#patch(transmit, 'broadcastExcept')
        if (this.#patches.length === 0) this.#active = false
      } catch (error) {
        this.cleanup()
        throw error
      }
    })
  }

  cleanup(): void {
    this.#active = false

    const unsubscribe = this.#unsubscribe
    this.#unsubscribe = undefined
    if (unsubscribe !== undefined) {
      safeguard('periscope.watcher.transmit.cleanup', unsubscribe)
    }

    for (const patch of this.#patches.splice(0).reverse()) {
      safeguard('periscope.watcher.transmit.restore', () => {
        if (readField(patch.target, patch.method) !== patch.wrapper) return

        if (patch.descriptor === undefined) {
          Reflect.deleteProperty(patch.target, patch.method)
        } else {
          Object.defineProperty(patch.target, patch.method, patch.descriptor)
        }
      })
    }
  }

  #patch(target: Record<PropertyKey, unknown>, method: BroadcastMethod): void {
    const original = readField(target, method)
    if (typeof original !== 'function') return

    const descriptor = Object.getOwnPropertyDescriptor(target, method)
    const watcher = this
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const result = Reflect.apply(original, this, args)

      safeguard(`periscope.watcher.transmit.${method}`, () => {
        const payload = watcher.#context.config.watchers.transmit.capturePayload
          ? args[1]
          : undefined
        watcher.#record(args[0], undefined, payload)
      })

      return result
    }

    if (descriptor === undefined) {
      Object.defineProperty(target, method, {
        configurable: true,
        writable: true,
        value: wrapper,
      })
    } else {
      Object.defineProperty(target, method, { ...descriptor, value: wrapper })
    }

    this.#patches.push({ target, method, descriptor, wrapper })
  }

  #record(rawChannel: unknown, rawEvent: unknown, rawPayload: unknown): void {
    if (!this.#active) return

    const channel = serializedString(rawChannel)
    if (channel === undefined) return

    const content: BroadcastEntryContent = { channel }
    const event = serializedString(rawEvent)
    if (event !== undefined) content.event = event

    if (this.#context.config.watchers.transmit.capturePayload && rawPayload !== undefined) {
      content.payloadSummary = safeSerialize(rawPayload)
    }

    this.#context.recorder.record(IncomingEntry.make(EntryType.BROADCAST, content))
    this.stats.recorded++
  }
}
