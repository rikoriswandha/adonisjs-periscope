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
import type {
  SocketConnectionEvent,
  SocketDisconnectionEvent,
  SocketMessageEvent,
  SocketWatcherObserver,
  Watcher,
} from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { SocketEntryContent } from './types.ts'

/**
 * Observes application-provided WebSocket bridges without coupling Periscope to a transport.
 * There is no official AdonisJS WebSocket package, so Periscope ships the observer contract and
 * applications bridge their own socket implementation through an adapter.
 */
export class SocketWatcher implements Watcher, SocketWatcherObserver {
  readonly name = WatcherName.SOCKET
  readonly stats = { recorded: 0 }

  readonly #context: WatcherContext
  readonly #cleanups: (() => void | Promise<void>)[] = []
  #active = false

  constructor(context: WatcherContext) {
    this.#context = context
  }

  async register(): Promise<void> {
    if (this.#active || !this.#context.config.watchers.socket.enabled) return
    this.#active = true

    for (const adapter of this.#context.config.watchers.socket.adapters) {
      const cleanup = await safeguardAsync('periscope.watcher.socket.register', () =>
        adapter.register(this, {
          capturePayload: this.#context.config.watchers.socket.capturePayload,
        })
      )
      if (typeof cleanup === 'function') this.#cleanups.push(cleanup)
    }
  }

  async cleanup(): Promise<void> {
    this.#active = false
    const cleanups = this.#cleanups.splice(0)
    await Promise.allSettled(
      cleanups.map((cleanup) =>
        safeguardAsync('periscope.watcher.socket.cleanup', () => Promise.resolve(cleanup()))
      )
    )
  }

  connected(event: SocketConnectionEvent): void {
    this.#record('connected', event)
  }

  disconnected(event: SocketDisconnectionEvent): void {
    this.#record('disconnected', event)
  }

  message(event: SocketMessageEvent): void {
    this.#record('message', event)
  }

  #record(
    kind: SocketEntryContent['event'],
    event: SocketConnectionEvent | SocketDisconnectionEvent | SocketMessageEvent
  ): void {
    safeguard(`periscope.watcher.socket.${kind}`, () => {
      if (!this.#active) return
      const message = kind === 'message' ? (event as SocketMessageEvent) : undefined
      const disconnected = kind === 'disconnected' ? (event as SocketDisconnectionEvent) : undefined
      const content: SocketEntryContent = {
        adapter: event.adapter,
        socketId: event.socketId,
        event: kind,
        ...(event.transport === undefined ? {} : { transport: event.transport }),
        ...(event.channel === undefined ? {} : { channel: event.channel }),
        ...(event.remoteAddress === undefined ? {} : { remoteAddress: event.remoteAddress }),
        ...(event.userId === undefined ? {} : { userId: event.userId }),
        ...(message === undefined
          ? {}
          : {
              direction: message.direction,
              ...(message.event === undefined ? {} : { messageEvent: message.event }),
              ...(message.sizeBytes === undefined ? {} : { sizeBytes: message.sizeBytes }),
              ...(this.#context.config.watchers.socket.capturePayload &&
              message.payload !== undefined
                ? { payload: safeSerialize(message.payload) }
                : {}),
            }),
        ...(disconnected?.durationMs === undefined ? {} : { durationMs: disconnected.durationMs }),
        ...(disconnected?.reason === undefined ? {} : { reason: disconnected.reason }),
      }
      const tags = [`socket:${event.socketId}`, kind]
      if (event.channel !== undefined) tags.push(`channel:${event.channel}`)
      if (message !== undefined) tags.push(message.direction)

      this.#context.recorder.record(IncomingEntry.make(EntryType.SOCKET, content).withTags(...tags))
      this.stats.recorded += 1
    })
  }
}
