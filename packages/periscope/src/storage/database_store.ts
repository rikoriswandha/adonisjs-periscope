/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The `database` storage driver (implementation plan P2.1): Periscope's tables living inside the
 * application's own Lucid connection.
 *
 * Two constraints shape everything below.
 *
 * **The connection belongs to the host.** Periscope borrows it; it does not own it, cannot
 * reconfigure it, and must not close it. That is why `close()` is a documented no-op, why the
 * foreign key on the tag table is treated as decoration rather than as a delete mechanism, and
 * why the query client is resolved per call instead of cached — Lucid may reconnect a pool
 * underneath a long-lived object, and a driver holding the client it was handed at boot would
 * keep talking to a dead one.
 *
 * **Query builder only, never a Lucid model.** Two reasons, and the second is the load-bearing
 * one. Models would drag `BaseModel` into Periscope's type surface and make an optional peer
 * dependency a compile-time one. More importantly the ModelWatcher (P6.4) installs recording
 * hooks on every model in the application: a Periscope model would record Periscope's own
 * writes, and each recorded write would produce another write. Invariant 2 — Periscope never
 * records itself — is enforced here, by not giving the watcher anything to attach to.
 *
 * Dialect differences are handled in exactly two places. `./sql.ts`'s codecs erase the value-level
 * ones (postgres returns a `bigint` column as a string where SQLite returns a number, and
 * `decodeJson` accepts either the JSON text every dialect now stores or an already-parsed value),
 * and knex's `onConflict().ignore()` erases the statement-level one, compiling to `on conflict do
 * nothing` on postgres and SQLite and to `insert ignore` on MySQL. Nothing else in this file
 * branches on `dialect.name`.
 */

import { EntryType } from '../types.ts'
import { encodeCursor, parseCursor, resolvePageSize } from './pagination.ts'
import { aggregateExceptionGroups } from './exception_groups.ts'
import {
  ENTRIES_TABLE,
  FLAGS_TABLE,
  INSERT_CHUNK_SIZE,
  MONITORED_TAGS_TABLE,
  TAGS_TABLE,
  encodeSequence,
  toEntryRow,
  toStoredEntry,
  toTagRows,
} from './sql.ts'
import type { EntryRow } from './sql.ts'
import type {
  EntryQuery,
  ExceptionGroup,
  ExceptionGroupQuery,
  EntryTypeCounts,
  FlagOptions,
  Paginated,
  PeriscopeStore,
  PruneOptions,
  StoredEntry,
} from '../types.ts'
import type { Database } from '@adonisjs/lucid/database'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { DatabaseQueryBuilderContract } from '@adonisjs/lucid/types/querybuilder'

/**
 * Options accepted by {@link DatabaseStore}.
 */
export type DatabaseStoreOptions = {
  /**
   * The application's Lucid database service — the same object `@adonisjs/lucid` binds as `db`.
   */
  db: Database

  /**
   * Connection name; defaults to Lucid's primary connection.
   */
  connection?: string
}

/**
 * One row of the monitored-tags table.
 */
type MonitoredTagRow = { tag: string }

/**
 * One row of the flags table. `expires_at` arrives as a string from postgres, because it is a
 * `bigint` column, and as a number from SQLite.
 */
type FlagRow = { value: string; expires_at: number | string | null }

/**
 * A grouped count. Postgres returns `count(*)` as a `bigint`, hence the string.
 */
type CountRow = { type: string; total: number | string }

/**
 * Slice an array into chunks of at most `size`.
 */
function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size)
  }
}

/**
 * The `database` value of `StorageDriverName`: Periscope's tables inside the application's own
 * database, created by the migration published from
 * `stubs/migrations/create_periscope_tables.stub`.
 *
 * See the module docblock for why the client is resolved per call, why no Lucid model appears
 * anywhere below, and why `close()` does nothing.
 */
export class DatabaseStore implements PeriscopeStore {
  readonly #db: Database
  readonly #connection: string | undefined

  constructor(options: DatabaseStoreOptions) {
    this.#db = options.db
    this.#connection = options.connection
  }

  /**
   * Resolve the query client for this store's connection.
   *
   * Deliberately called afresh on every operation rather than cached in the constructor: Lucid
   * owns the pool's lifecycle and can replace the underlying connection, and `connection()` is a
   * map lookup — cheap enough that caching it would only buy the chance to hold a stale one.
   * Passing `undefined` selects Lucid's primary connection, which is what an application that
   * did not name one in `config/periscope.ts` means.
   */
  #client(): QueryClientContract {
    return this.#db.connection(this.#connection)
  }

  /**
   * Apply every filter of a query, plus the cursor, to a builder over the entries table.
   *
   * The tag filter is a subquery rather than a join. A join against the tag index would produce
   * one row per matching tag, which is invisible for a single-tag filter but would silently
   * duplicate entries the moment the query grew a second tag — and would break `limit + 1`
   * pagination well before anyone noticed the duplicates.
   */
  #applyFilters(
    builder: DatabaseQueryBuilderContract<EntryRow>,
    query: EntryQuery,
    cursor: bigint | null
  ): void {
    if (query.type !== undefined) {
      builder.where('type', query.type)
    }

    if (query.familyHash !== undefined) {
      builder.where('family_hash', query.familyHash)
    }

    if (query.batchId !== undefined) {
      builder.where('batch_id', query.batchId)
    }

    if (query.displayOnIndex !== undefined) {
      builder.where('should_display_on_index', query.displayOnIndex ? 1 : 0)
    }

    if (query.tag !== undefined) {
      const tag = query.tag

      builder.whereIn('uuid', (subquery: DatabaseQueryBuilderContract<EntryRow>) => {
        subquery.from(TAGS_TABLE).select('entry_uuid').where('tag', tag)
      })
    }

    /*
     * Strictly less than, against the padded encoding rather than the raw digits: the column is
     * fixed-width text, so `'00000000001800000000977' < '00000000001800000001954'` only agrees
     * with the numeric comparison while both sides are padded to the same width.
     */
    if (cursor !== null) {
      builder.where('sequence', '<', encodeSequence(cursor))
    }
  }

  /**
   * Delete the tag rows of every entry matched by `select`, then the entries themselves, and
   * report how many entries went.
   *
   * Takes the transaction rather than opening one. Both callers have their own reason to own it:
   * `prune` so the two deletes land together, `trim` so the boundary it deletes below is read
   * under the same snapshot as the delete that uses it. A method that opened its own transaction
   * would put that read outside it, which is the whole bug this shape exists to avoid.
   *
   * Tag rows are removed explicitly and first: the foreign key would cascade on postgres, but
   * SQLite only honours it under `PRAGMA foreign_keys = ON` and this driver is not allowed to
   * change the pragmas of a connection it borrowed. Relying on the cascade would therefore leave
   * orphaned tag rows on exactly the dialect most applications develop against, and
   * `list({ tag })` would keep matching entries that no longer exist.
   */
  async #deleteEntries(
    trx: TransactionClientContract,
    select: (builder: DatabaseQueryBuilderContract<EntryRow>) => void
  ): Promise<number> {
    const tags = trx.query().from(TAGS_TABLE)

    tags.whereIn('entry_uuid', (subquery: DatabaseQueryBuilderContract<EntryRow>) => {
      subquery.from(ENTRIES_TABLE).select('uuid')
      select(subquery)
    })

    await tags.del()

    const entries = trx.query<EntryRow>().from(ENTRIES_TABLE)
    select(entries)

    /*
     * Lucid types every query builder as resolving to rows, but knex resolves a `delete` to
     * the affected-row count on all three dialects Periscope supports. The cast describes the
     * runtime value the types cannot; `Number` plus the `|| 0` guard means a dialect that ever
     * returns something else degrades to "reported nothing" rather than leaking `NaN` into a
     * pruning report.
     */
    const deleted: unknown = await entries.del()

    return Number(deleted) || 0
  }

  async save(entries: StoredEntry[]): Promise<void> {
    if (entries.length === 0) {
      return
    }

    const entryRows = entries.map(toEntryRow)
    const tagRows = entries.flatMap(toTagRows)

    /*
     * One transaction for the whole batch, so a reader can never see an entry whose tag rows have
     * not landed yet — `list({ tag })` would report the entry as untagged for the width of the
     * window, which on a dashboard that polls is a visible flicker rather than a race nobody
     * hits.
     */
    await this.#client().transaction(async (trx) => {
      for (const chunk of chunked(entryRows, INSERT_CHUNK_SIZE)) {
        /*
         * Conflicts are ignored rather than merged. A conflict here means the same uuid is being
         * saved twice, which only happens when a flush is retried after a partial failure; the
         * rows are identical, so the cheapest correct answer is to keep what is already there.
         * Failing instead would cost every other entry in the batch.
         */
        await trx.insertQuery().table(ENTRIES_TABLE).multiInsert(chunk).onConflict('uuid').ignore()
      }

      for (const chunk of chunked(tagRows, INSERT_CHUNK_SIZE)) {
        await trx
          .insertQuery()
          .table(TAGS_TABLE)
          .multiInsert(chunk)
          .onConflict(['entry_uuid', 'tag'])
          .ignore()
      }
    })
  }

  async find(uuid: string): Promise<StoredEntry | null> {
    const row = await this.#client()
      .query<EntryRow>()
      .from(ENTRIES_TABLE)
      .where('uuid', uuid)
      .first()

    return row === null || row === undefined ? null : toStoredEntry(row)
  }

  async list(query: EntryQuery = {}): Promise<Paginated<StoredEntry>> {
    const limit = resolvePageSize(query.limit)
    const builder = this.#client().query<EntryRow>().from(ENTRIES_TABLE)

    this.#applyFilters(builder, query, parseCursor(query.cursor))

    /*
     * One row more than the page: its existence is the whole answer to "is there a next page?",
     * and it costs one row rather than the `count(*)` over the same predicate that the obvious
     * alternative would need.
     */
    const rows = await builder.orderBy('sequence', 'desc').limit(limit + 1)
    const page = rows.slice(0, limit)

    return {
      data: page.map(toStoredEntry),
      nextCursor:
        rows.length > limit ? encodeCursor(toStoredEntry(page[page.length - 1]).sequence) : null,
    }
  }

  async batch(batchId: string): Promise<StoredEntry[]> {
    // Oldest first: the batch screen is a timeline, the opposite of every index screen.
    const rows = await this.#client()
      .query<EntryRow>()
      .from(ENTRIES_TABLE)
      .where('batch_id', batchId)
      .orderBy('sequence', 'asc')

    return rows.map(toStoredEntry)
  }

  async counts(): Promise<EntryTypeCounts> {
    const rows = await this.#client()
      .query<CountRow>()
      .from(ENTRIES_TABLE)
      .select('type')
      .count('* as total')
      .groupBy('type')

    const counts: EntryTypeCounts = {}

    for (const row of rows) {
      counts[row.type as EntryType] = Number(row.total)
    }

    return counts
  }

  async exceptionGroups(query: ExceptionGroupQuery = {}): Promise<Paginated<ExceptionGroup>> {
    const builder = this.#client()
      .query<EntryRow>()
      .from(ENTRIES_TABLE)
      .where('type', EntryType.EXCEPTION)
      .whereNotNull('family_hash')

    this.#applyFilters(builder, query, null)

    const rows = await builder
    return aggregateExceptionGroups(rows.map(toStoredEntry), query)
  }

  async prune(options: PruneOptions): Promise<number> {
    const before = options.before.getTime()
    const keepExceptions = options.keepExceptions === true

    return this.#client().transaction(async (trx) =>
      this.#deleteEntries(trx, (builder) => {
        builder.where('created_at', '<', before)

        if (keepExceptions) {
          builder.whereNot('type', EntryType.EXCEPTION)
        }
      })
    )
  }

  async trim(maxEntries: number): Promise<number> {
    const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 0
    const client = this.#client()

    /*
     * A scheduling hint and nothing more. The recorder trims after every flush, so the common
     * call has nothing to do, and one `count(*)` outside a transaction is the cheapest way to
     * learn that. What this number must never do is decide *how much* to delete: another
     * process's trim or prune can shrink the table between here and the transaction below, and
     * an excess measured against a table that no longer exists is how a cap of a thousand ends
     * up holding two hundred rows.
     */
    const [{ total }] = await client
      .query<{ total: number | string }>()
      .from(ENTRIES_TABLE)
      .count('* as total')

    if (Number(total) <= cap) {
      return 0
    }

    return client.transaction(async (trx) => {
      if (cap === 0) {
        // Nothing survives a cap of zero, so there is no boundary row to look for.
        return this.#deleteEntries(trx, () => {})
      }

      /*
       * The survivors are defined by the cap, inside the transaction: take the `sequence` of the
       * `cap`-th newest entry and delete everything strictly below it. Whatever else ran in the
       * meantime, what is left afterwards is the newest `cap` entries — which is exactly what
       * `maxEntries` promises — and the answer is one boundary value rather than a
       * `where uuid in (...)` listing every doomed row, which at trim scale would blow SQLite's
       * bind-parameter ceiling and hold a few hundred thousand uuids in memory to do it.
       */
      const boundary = await trx
        .query<{ sequence: string }>()
        .from(ENTRIES_TABLE)
        .select('sequence')
        .orderBy('sequence', 'desc')
        .offset(cap - 1)
        .limit(1)
        .first()

      /*
       * Fewer entries than the cap by the time the transaction opened, so the hint was overtaken
       * and there is nothing left to trim. Returning zero here is the difference between a race
       * that costs a wasted transaction and one that empties the table.
       */
      if (boundary === null || boundary === undefined) {
        return 0
      }

      const oldestKept = boundary.sequence

      return this.#deleteEntries(trx, (builder) => {
        builder.where('sequence', '<', oldestKept)
      })
    })
  }

  async clear(): Promise<void> {
    /*
     * A delete rather than a truncate. `truncate` is DDL on some dialects (implicitly committing
     * an open transaction), needs `cascade` on postgres to get past the foreign key, and resets
     * identity columns nobody asked it to touch. The tables are bounded by `maxEntries`, so the
     * delete is cheap enough that none of that is worth buying.
     *
     * Monitored tags and flags are untouched on purpose: they are user intent, not recorded data.
     */
    await this.#client().transaction(async (trx) => {
      await trx.query().from(TAGS_TABLE).del()
      await trx.query().from(ENTRIES_TABLE).del()
    })
  }

  async monitoredTags(): Promise<string[]> {
    // Ordered so two calls against the same data return the same array; the dashboard renders it.
    const rows = await this.#client()
      .query<MonitoredTagRow>()
      .from(MONITORED_TAGS_TABLE)
      .select('tag')
      .orderBy('tag', 'asc')

    return rows.map((row) => row.tag)
  }

  async monitorTag(tag: string): Promise<void> {
    // Monitoring an already-monitored tag is a no-op, which is precisely `on conflict do nothing`.
    await this.#client()
      .insertQuery()
      .table(MONITORED_TAGS_TABLE)
      .insert({ tag })
      .onConflict('tag')
      .ignore()
  }

  async unmonitorTag(tag: string): Promise<void> {
    await this.#client().query().from(MONITORED_TAGS_TABLE).where('tag', tag).del()
  }

  async getFlag(name: string): Promise<string | null> {
    const client = this.#client()
    const row = await client.query<FlagRow>().from(FLAGS_TABLE).where('name', name).first()

    if (row === null || row === undefined) {
      return null
    }

    /*
     * Expiry is evaluated on read and the dead row is swept as a side effect. There is no timer
     * to leak and nothing to drain at shutdown, and the flags this backs — `paused`, `dump-open`
     * — are read far more often than they are written, so the sweep costs a delete only on the
     * one read that discovers the expiry.
     */
    if (row.expires_at !== null && Number(row.expires_at) <= Date.now()) {
      await client.query().from(FLAGS_TABLE).where('name', name).del()

      return null
    }

    return row.value
  }

  async setFlag(name: string, value: string, options: FlagOptions = {}): Promise<void> {
    const expiresAt = options.expiresAt === undefined ? null : options.expiresAt.getTime()

    /*
     * `merge` lists both columns explicitly, so setting a flag without an expiry writes `null`
     * over whatever expiry the previous value carried. Merging only `value` would leave a stale
     * expiry behind and make a freshly set flag read back as absent.
     */
    await this.#client()
      .insertQuery()
      .table(FLAGS_TABLE)
      .insert({ name, value, expires_at: expiresAt })
      .onConflict('name')
      .merge(['value', 'expires_at'])
  }

  async deleteFlag(name: string): Promise<void> {
    await this.#client().query().from(FLAGS_TABLE).where('name', name).del()
  }

  /**
   * Releases nothing, on purpose: the connection belongs to the application, and Lucid closes it
   * during its own shutdown. Closing it here would take the host's database down with Periscope's
   * provider — the exact failure this method looks like it should perform.
   *
   * Idempotent by construction, which the contract requires: shutdown can run more than once.
   */
  async close(): Promise<void> {}
}
