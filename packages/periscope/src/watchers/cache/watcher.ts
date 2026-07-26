/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { IncomingEntry } from '../../entry.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { CacheEntryContent, CacheEventMap, CacheOperation } from './types.ts'

/**
 * The slice of the shared AdonisJS emitter used by this watcher.
 *
 * Bentocache augments the application's event map from optional provider declarations. Periscope
 * must still compile when `@adonisjs/cache` is absent, so the five events are expressed as a
 * structural contract instead of importing provider types or weakening the listeners to `any`.
 */
type CacheEventSource = {
  on<Event extends keyof CacheEventMap>(
    event: Event,
    listener: (payload: CacheEventMap[Event]) => void
  ): () => void
}

type CachePayload = {
  store: string
  key?: string
  value?: unknown
  layer?: 'l1' | 'l2'
  graced?: boolean
}

export class CacheWatcher implements Watcher {
  readonly name = WatcherName.CACHE
  readonly stats = { recorded: 0 }

  readonly #context: WatcherContext
  readonly #unsubscribers: (() => void)[] = []

  constructor(context: WatcherContext) {
    this.#context = context
  }

  /** Stable listener identities prevent a defensive second registration from duplicating work. */
  readonly #handleHit = (payload: CacheEventMap['cache:hit']): void => {
    safeguard('periscope.watcher.cache.hit', () => this.#record('hit', payload, true))
  }

  readonly #handleMiss = (payload: CacheEventMap['cache:miss']): void => {
    safeguard('periscope.watcher.cache.miss', () => this.#record('miss', payload, false))
  }

  readonly #handleWritten = (payload: CacheEventMap['cache:written']): void => {
    safeguard('periscope.watcher.cache.written', () => this.#record('set', payload, true))
  }

  readonly #handleDeleted = (payload: CacheEventMap['cache:deleted']): void => {
    safeguard('periscope.watcher.cache.deleted', () => this.#record('delete', payload, false))
  }

  readonly #handleCleared = (payload: CacheEventMap['cache:cleared']): void => {
    safeguard('periscope.watcher.cache.cleared', () => this.#record('clear', payload, false))
  }

  register(): void {
    if (this.#unsubscribers.length !== 0) {
      return
    }

    const source = this.#context.emitter as unknown as CacheEventSource

    /**
     * Retain each unsubscribe immediately. If a later subscription throws, registry cleanup can
     * still remove every listener that was installed before the failure.
     */
    this.#unsubscribers.push(source.on('cache:hit', this.#handleHit))
    this.#unsubscribers.push(source.on('cache:miss', this.#handleMiss))
    this.#unsubscribers.push(source.on('cache:written', this.#handleWritten))
    this.#unsubscribers.push(source.on('cache:deleted', this.#handleDeleted))
    this.#unsubscribers.push(source.on('cache:cleared', this.#handleCleared))
  }

  cleanup(): void {
    const unsubscribers = this.#unsubscribers.splice(0).reverse()

    for (const unsubscribe of unsubscribers) {
      safeguard('periscope.watcher.cache.cleanup', unsubscribe)
    }
  }

  #record(operation: CacheOperation, payload: CachePayload, carriesValue: boolean): void {
    const content: CacheEntryContent = {
      operation,
      store: payload.store,
      ...(payload.key === undefined ? {} : { key: payload.key }),
      ...(payload.layer === undefined ? {} : { layer: payload.layer }),
      ...(payload.graced === undefined ? {} : { graced: payload.graced }),
    }

    if (carriesValue && this.#context.config.watchers.cache.captureValues) {
      content.value = safeSerialize(payload.value)
    }

    this.#context.recorder.record(
      IncomingEntry.make(EntryType.CACHE, content).withTags(
        `operation:${operation}`,
        `store:${payload.store}`,
        payload.layer === undefined ? undefined : `layer:${payload.layer}`,
        payload.graced === true ? 'graced' : undefined
      )
    )
    this.stats.recorded++
  }
}
