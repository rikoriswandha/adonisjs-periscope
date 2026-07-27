/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { DbQueryEventNode } from '@adonisjs/lucid/types/database'

import { IncomingEntry } from '../../entry.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { StorageDriverName, Watcher } from '../../types.ts'
import { ENTRIES_TABLE, FLAGS_TABLE, MONITORED_TAGS_TABLE, TAGS_TABLE } from '../../storage/sql.ts'
import { familyHash } from '../hash.ts'
import type { WatcherContext } from '../context.ts'
import { normaliseSql } from './normalise_sql.ts'
import type { QueryEntryContent, QueryWatcherStats } from './types.ts'

/**
 * Lucid's declared event type omits the `error` key that QueryReporter always adds at runtime.
 * The key is `undefined` for successful queries and the driver Error for failures. This local
 * intersection documents the one intentional widening without allowing the rest of knex's
 * undeclared payload to leak into Periscope's content contract.
 */
type RuntimeDbQueryEvent = DbQueryEventNode & { error?: Error }

/**
 * The slice of the emitter this watcher uses.
 *
 * `db:query` reaches the framework's `EventsList` through a `declare module` block inside
 * `@adonisjs/lucid`'s *provider* types, and those are only loaded by a project that imports the
 * provider. Periscope declares Lucid as an **optional** peer and must therefore compile in a
 * project that has never heard of it — so the event name cannot be typed through `EventsList`
 * without making the optional peer mandatory at compile time.
 *
 * Structural typing is the honest way out: this is exactly the contract the watcher relies on,
 * written down where it can be checked against the payload type, rather than an `as any` at the
 * call site that documents nothing.
 */
type QueryEventSource = {
  on(event: 'db:query', listener: (event: RuntimeDbQueryEvent) => void): () => void
}

/**
 * Periscope's own tables. Only the `database` driver puts these on the application's Lucid
 * connection; `sqlite-local` opens a file of its own and `memory` touches no database at all.
 */
const PERISCOPE_TABLES = [ENTRIES_TABLE, TAGS_TABLE, MONITORED_TAGS_TABLE, FLAGS_TABLE]

/**
 * Whether a query is Periscope writing about Periscope (§0, invariant 2).
 *
 * The plan phrases this gate as "drop when the query's connection is Periscope's". That is the
 * right *intent* expressed through the wrong proxy: the `database` driver's whole selling point
 * is that it reuses a connection the application already has, so an application that names its
 * one connection explicitly would have every query it makes attributed to Periscope and dropped.
 * Recording nothing is a worse failure than recording too much, and it is a silent one.
 *
 * Matching the table names computes the same intent exactly, on any connection, and cannot eat
 * host traffic: a statement naming `periscope_entries` is Periscope's business by construction —
 * and on the vanishing chance an application queries those tables itself, it is querying
 * recordings, which is precisely what a debug assistant must not record.
 *
 * `BatchScope.mute()` already covers the recorder's flush, its trim and its paused-flag read.
 * This covers what mute cannot see from the inside: a prune command, a dashboard controller, or
 * any future Periscope code path that reaches the store without remembering to mute first.
 */
function isPeriscopeTraffic(driver: StorageDriverName, sql: string): boolean {
  if (driver !== 'database') {
    return false
  }

  return PERISCOPE_TABLES.some((table) => sql.includes(table))
}

/**
 * Observe Lucid query reports and turn them into independently searchable query entries.
 *
 * Lucid only emits `db:query` when the connection's top-level `debug` option is true. The public
 * counters intentionally measure events observed here rather than entries eventually persisted,
 * so tests and host diagnostics can distinguish missing Lucid instrumentation from recorder caps
 * or a paused store. The P7.4 init hook performs the actionable boot-time check directly against
 * each resolved Lucid connection's `debug` flag.
 *
 * **No call site is recorded, and cannot be.** The plan (P3.3) asks for a dev-only capture of the
 * application frame that issued the query, via `Error.captureStackTrace` at record time. That
 * works only if the listener runs on the caller's stack, and it does not: `QueryReporter` emits
 * after the query settles, Emittery dispatches every listener a microtask later, and by then the
 * stack is `Emittery.emit` over `processTicksAndRejections` with no application frame left on it.
 * Measured, not assumed — a probe against the installed Lucid and Emittery found exactly zero
 * application frames in the listener *and* in the synchronous `adonisjs.event.dispatch` tracing
 * hook, which sits one frame below the emit inside `QueryReporter.emitQueryEvent`.
 *
 * Recovering it would take a hook that runs where the query is *built* — a Lucid-side reporter
 * extension point, or knex's `asyncStackTraces`, which today attaches a builder-time stack to
 * errors only. Until one exists, the honest thing is to record no location rather than to ship a
 * `captureLocation` switch whose `always` setting costs a stack walk per query and stores
 * nothing. The batch's `route:` tag is what cross-filters a query back to the code that ran it.
 */
export class QueryWatcher implements Watcher {
  readonly name = WatcherName.QUERY
  readonly stats: QueryWatcherStats = { recorded: 0, dropped: 0 }

  readonly #context: WatcherContext
  #unsubscribe: (() => void) | null = null

  constructor(context: WatcherContext) {
    this.#context = context
  }

  /**
   * Subscribe early enough to satisfy Lucid's listener-at-query-start gate.
   *
   * Registration is idempotent even though the registry calls it once. This keeps a test or a
   * host lifecycle retry from installing duplicate listeners and inflating every query family.
   */
  register(): void {
    if (this.#unsubscribe !== null) {
      return
    }

    /**
     * The one cast in this file, and the reason it is safe: `EmitterService` really does expose
     * `on(name, listener): UnsubscribeFunction` for arbitrary string events at runtime — the
     * narrowing to known names is a compile-time convenience of the framework's typed event map,
     * which Lucid populates from types this package may not have.
     */
    const source = this.#context.emitter as unknown as QueryEventSource

    this.#unsubscribe = source.on('db:query', (event) => {
      safeguard('periscope.watcher.query.record', () => this.#record(event))
    })
  }

  /**
   * Remove the emitter listener exactly once.
   */
  cleanup(): void {
    const unsubscribe = this.#unsubscribe
    if (unsubscribe === null) {
      return
    }

    this.#unsubscribe = null
    unsubscribe()
  }

  /**
   * Build and record one query entry. The active BatchScope is deliberately not inspected here:
   * emitter callbacks inherit the request's async scope, and `Recorder.record` owns the ambient
   * fallback for queries issued outside one.
   */
  #record(event: DbQueryEventNode): void {
    const { config, recorder } = this.#context

    if (isPeriscopeTraffic(config.storage.driver, event.sql)) {
      this.stats.dropped++
      return
    }

    const durationMs = event.duration
      ? event.duration[0] * 1_000 + event.duration[1] / 1_000_000
      : undefined
    const queryConfig = config.watchers.query
    const runtimeEvent = event as RuntimeDbQueryEvent

    const content: QueryEntryContent = {
      sql: event.sql,
      bindings: queryConfig.hideBindings
        ? { count: event.bindings?.length ?? 0 }
        : safeSerialize(event.bindings ?? []),
      connection: event.connection,
      method: event.method,
      ...(event.model === undefined ? {} : { model: event.model }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(event.inTransaction === undefined ? {} : { inTransaction: event.inTransaction }),
      ...(event.ddl === undefined ? {} : { ddl: event.ddl }),
      ...(runtimeEvent.error === undefined
        ? {}
        : { error: { name: runtimeEvent.error.name, message: runtimeEvent.error.message } }),
    }

    const entry = IncomingEntry.make(EntryType.QUERY, content)
      .withFamilyHash(familyHash(normaliseSql(event.sql)))
      .withTags(
        `connection:${event.connection}`,
        durationMs !== undefined && durationMs >= queryConfig.slowMs ? 'slow' : undefined,
        `method:${event.method}`,
        event.model === undefined ? undefined : `model:${event.model}`
      )

    recorder.record(entry)
    this.stats.recorded++
  }
}
