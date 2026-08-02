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
  NotificationEvent,
  NotificationResult,
  NotificationWatcherObserver,
  Watcher,
} from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { NotificationEntryContent } from './types.ts'

/**
 * Observes application-provided notification bridges without coupling Periscope to a transport.
 * There is no official AdonisJS notification package, so Periscope ships the observer contract
 * and applications bridge their own notification implementation through an adapter.
 */
export class NotificationWatcher implements Watcher, NotificationWatcherObserver {
  readonly name = WatcherName.NOTIFICATION
  readonly stats = { sent: 0, failed: 0 }

  readonly #context: WatcherContext
  readonly #cleanups: (() => void | Promise<void>)[] = []
  #active = false

  constructor(context: WatcherContext) {
    this.#context = context
  }

  async register(): Promise<void> {
    if (this.#active || !this.#context.config.watchers.notification.enabled) return
    this.#active = true

    for (const adapter of this.#context.config.watchers.notification.adapters) {
      const cleanup = await safeguardAsync('periscope.watcher.notification.register', () =>
        adapter.register(this, {
          capturePayload: this.#context.config.watchers.notification.capturePayload,
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
        safeguardAsync('periscope.watcher.notification.cleanup', () => Promise.resolve(cleanup()))
      )
    )
  }

  sent(event: NotificationEvent): void {
    this.#record('sent', event)
  }

  failed(event: NotificationResult): void {
    this.#record('failed', event)
  }

  #record(status: NotificationEntryContent['status'], event: NotificationResult): void {
    safeguard(`periscope.watcher.notification.${status}`, () => {
      if (!this.#active) return
      const content: NotificationEntryContent = {
        adapter: event.adapter,
        channel: event.channel,
        notification: event.notification,
        status,
        ...(event.notifiable === undefined ? {} : { notifiable: event.notifiable }),
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        ...(this.#context.config.watchers.notification.capturePayload && event.payload !== undefined
          ? { payload: safeSerialize(event.payload) }
          : {}),
        ...(event.error === undefined ? {} : { error: safeSerialize(event.error) }),
      }

      this.#context.recorder.record(
        IncomingEntry.make(EntryType.NOTIFICATION, content).withTags(
          `channel:${event.channel}`,
          `notification:${event.notification}`,
          status
        )
      )
      this.stats[status] += 1
    })
  }
}
