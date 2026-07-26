/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Cache operations exposed by Periscope. Bentocache calls a write `cache:written`; the entry
 * vocabulary deliberately presents that operation as the more familiar `set`.
 */
export type CacheOperation = 'hit' | 'miss' | 'set' | 'delete' | 'clear'

/**
 * The JSON-representable cache detail handed to the recorder. Application values cross this
 * boundary only after safe serialization, and only when value capture is enabled.
 */
export type CacheEntryContent = {
  operation: CacheOperation
  store: string
  key?: string
  layer?: 'l1' | 'l2'
  graced?: boolean
  value?: unknown
}

/**
 * Structural descriptions of the Bentocache payloads consumed by the watcher. Keeping these
 * contracts local means applications can use Periscope without installing `@adonisjs/cache`.
 */
export interface CacheHitPayload {
  key: string
  value: unknown
  store: string
  layer?: 'l1' | 'l2'
  graced?: boolean
}

export interface CacheMissPayload {
  key: string
  store: string
}

export interface CacheWrittenPayload {
  key: string
  value: unknown
  store: string
}

export interface CacheDeletedPayload {
  key: string
  store: string
}

export interface CacheClearedPayload {
  store: string
}

export interface CacheEventMap {
  'cache:hit': CacheHitPayload
  'cache:miss': CacheMissPayload
  'cache:written': CacheWrittenPayload
  'cache:deleted': CacheDeletedPayload
  'cache:cleared': CacheClearedPayload
}
