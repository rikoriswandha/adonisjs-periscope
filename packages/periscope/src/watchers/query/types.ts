/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The safe subset of an error carried by Lucid's runtime query event.
 *
 * Driver errors often contain the SQL, bindings and connection details on enumerable custom
 * properties. A query entry already records the useful query data explicitly, so retaining only
 * the name and message avoids serialising arbitrary driver state (and potentially user data).
 */
export type QueryError = {
  name: string
  message: string
}

/**
 * Content recorded for one Lucid query.
 *
 * Bindings have already passed through the shared safe serialiser by the time this shape reaches
 * the recorder. With `hideBindings` enabled they instead have the compact `{ count }` shape, so
 * an operator can still tell a bulk query from a scalar one without storing user data.
 */
export type QueryEntryContent = {
  sql: string
  bindings: unknown
  connection: string
  model?: string
  method: string
  durationMs?: number
  inTransaction?: boolean
  ddl?: boolean
  error?: QueryError
}

/**
 * Cheap lifetime counters exposed for the doctor hook.
 *
 * The useful health signature is "requests happened but zero queries recorded": Lucid emits no
 * `db:query` events when a connection has `debug: false`. `dropped` separates events discarded by
 * the storage recursion gate from events that never arrived in the first place.
 */
export type QueryWatcherStats = {
  recorded: number
  dropped: number
}
