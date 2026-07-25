/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Public type surface of Periscope.
 *
 * Phase 0 declares only what Phase 0 genuinely needs: the `EntryType` catalogue that every
 * watcher, storage driver and dashboard screen keys off, and the `BatchKind` discriminator
 * used by the batch context.
 *
 * The richer surface — `IncomingEntry`, `StoredEntry`, `EntryQuery`, `Paginated`, and the
 * store / watcher / config interfaces — is implemented in Phase 1 (P1.1) and deliberately
 * left out here rather than half-invented.
 */

/**
 * Every kind of entry Periscope can record. Watchers are added across phases 1 to 6, but the
 * catalogue is fixed now because storage schemas, dashboard routes and config keys are all
 * derived from it.
 */
export const EntryType = {
  REQUEST: 'request',
  QUERY: 'query',
  EXCEPTION: 'exception',
  LOG: 'log',
  EVENT: 'event',
  COMMAND: 'command',
  MAIL: 'mail',
  CACHE: 'cache',
  MODEL: 'model',
  GATE: 'gate',
  DUMP: 'dump',
  HTTP_CLIENT: 'http_client',
  SCHEDULE: 'schedule',
  JOB: 'job',
  NOTIFICATION: 'notification',
  REDIS: 'redis',
  SESSION: 'session',
} as const

/**
 * Union of the recordable entry types.
 */
export type EntryType = (typeof EntryType)[keyof typeof EntryType]

/**
 * What caused a batch of entries to be recorded. `ambient` covers everything that happens
 * outside a request, command, queue job or test — it is drained by a rotating module-level
 * context (P1.2).
 */
export type BatchKind = 'request' | 'command' | 'queue' | 'test' | 'ambient'
