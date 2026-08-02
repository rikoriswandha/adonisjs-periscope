/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The `database` storage driver: Periscope's tables living inside the application's own Lucid
 * connection.
 *
 * Two constraints shape everything below.
 *
 * **The connection belongs to the host.** Periscope borrows it; it does not own it, cannot
 * reconfigure it, and must not close it. `close()` only drains Periscope's bounded write queue.
 * The foreign key on the tag table is treated as decoration rather than as a delete mechanism,
 * and the query client is resolved per call instead of cached — Lucid may reconnect a pool
 * underneath a long-lived object, and a driver holding the client it was handed at boot would
 * keep talking to a dead one.
 *
 * **Query builder only, never a Lucid model.** Two reasons, and the second is the load-bearing
 * one. Models would drag `BaseModel` into Periscope's type surface and make an optional peer
 * dependency a compile-time one. More importantly the ModelWatcher installs recording
 * hooks on every model in the application: a Periscope model would record Periscope's own
 * writes, and each recorded write would produce another write. Invariant 2 — Periscope never
 * records itself — is enforced here, by not giving the watcher anything to attach to.
 *
 * Dialect differences are handled at exactly three seams. `./sql.ts`'s codecs erase the
 * value-level ones, and its `jsonFieldText` helper owns the dialect-specific JSON extraction
 * syntax used below. Knex's `onConflict().ignore()` erases the statement-level one, compiling to
 * `on conflict do nothing` on postgres and SQLite and to `insert ignore` on MySQL. Nothing else
 * in this file branches on `dialect.name`.
 */

import { safeguard } from '../safeguard.ts'
import { EntryType } from '../types.ts'
import {
  encodeCursor,
  encodeEntryCursor,
  parseCursor,
  parseEntryCursor,
  resolvePageSize,
} from './pagination.ts'
import {
  ENTRIES_TABLE,
  FLAGS_TABLE,
  INSERT_CHUNK_SIZE,
  MONITORED_TAGS_TABLE,
  TAGS_TABLE,
  entryContentLikePattern,
  encodeSequence,
  jsonFieldText,
  parseEntryQueryDate,
  resolveEntryQueryTags,
  toEntryRow,
  toStoredEntry,
  toTagRows,
} from './sql.ts'
import type { EntryRow, TagRow } from './sql.ts'
import {
  aggregateRequestStats,
  REQUEST_STATS_MAX_SAMPLES,
  requestStatsSampleFromRow,
} from './request_stats.ts'
import type {
  ApplicationSummary,
  EntryQuery,
  ExceptionGroup,
  ExceptionGroupQuery,
  EntryTypeCounts,
  FlagOptions,
  Paginated,
  PeriscopeStore,
  PruneOptions,
  RequestStatsQuery,
  RequestStatsResult,
  StoredEntry,
} from '../types.ts'
import type { EntryCursor } from './pagination.ts'
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

interface PendingDatabaseSave {
  entryRows: EntryRow[]
  tagRows: TagRow[]
  resolve(): void
  reject(error: unknown): void
}

/**
 * One active transaction plus at most this many waiting batches bounds both pool pressure and
 * retained request contexts when the host database is slower than incoming requests.
 */
const DATABASE_SAVE_BACKLOG_LIMIT = 64

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
 * anywhere below, and why `close()` drains writes without closing the connection.
 */
export class DatabaseStore implements PeriscopeStore {
  readonly #db: Database
  readonly #connection: string | undefined
  readonly #pendingSaves: PendingDatabaseSave[] = []
  #drainingSaves: Promise<void> | null = null

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
   * Tags are matched through a grouped subquery rather than a join. The grouping enforces
   * multi-tag AND without duplicating entry rows, so `limit + 1` cursor pagination keeps exactly
   * the same semantics under every filter combination.
   */
  #applyFilters(
    builder: DatabaseQueryBuilderContract<EntryRow>,
    query: EntryQuery,
    cursor: EntryCursor | null,
    dialect: string
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

    if (query.application !== undefined) {
      builder.where('application', query.application)
    }

    if (query.displayOnIndex !== undefined) {
      builder.where('should_display_on_index', query.displayOnIndex ? 1 : 0)
    }

    if (query.level !== undefined) {
      builder.whereRaw(`lower(${jsonFieldText(dialect, 'content', 'level')}) = ?`, [
        query.level.toLowerCase(),
      ])
    }

    const tags = resolveEntryQueryTags(query)
    if (tags.length === 1) {
      builder.whereIn('uuid', (subquery: DatabaseQueryBuilderContract<EntryRow>) => {
        subquery.from(TAGS_TABLE).select('entry_uuid').where('tag', tags[0])
      })
    } else if (tags.length > 1) {
      builder.whereIn('uuid', (subquery: DatabaseQueryBuilderContract<EntryRow>) => {
        subquery
          .from(TAGS_TABLE)
          .select('entry_uuid')
          .whereIn('tag', [...tags])
          .groupBy('entry_uuid')
          .havingRaw('count(*) = ?', [tags.length])
      })
    }

    if (query.text !== undefined) {
      builder.whereRaw("lower(content) like ? escape '!'", [entryContentLikePattern(query.text)])
    }

    const from = parseEntryQueryDate(query.from)
    if (from !== undefined) {
      builder.where('created_at', '>=', from)
    }

    const to = parseEntryQueryDate(query.to)
    if (to !== undefined) {
      builder.where('created_at', '<=', to)
    }

    if (cursor !== null) {
      const sequence = encodeSequence(cursor.sequence)
      const cursorOperator = query.direction === 'asc' ? '>' : '<'

      if (cursor.uuid === null) {
        builder.where('sequence', cursorOperator, sequence)
      } else {
        builder.whereRaw(
          `(sequence ${cursorOperator} ? or (sequence = ? and uuid ${cursorOperator} ?))`,
          [sequence, sequence, cursor.uuid]
        )
      }
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

    return new Promise<void>((resolve, reject) => {
      if (this.#pendingSaves.length >= DATABASE_SAVE_BACKLOG_LIMIT) {
        const dropped = this.#pendingSaves.shift()
        if (dropped !== undefined) {
          const error = new Error(
            `Periscope database write backlog exceeded ${DATABASE_SAVE_BACKLOG_LIMIT} pending batches`
          )
          dropped.reject(error)
          safeguard('periscope.storage.database.backpressure', () => {
            throw error
          })
        }
      }

      this.#pendingSaves.push({
        entryRows: entries.map(toEntryRow),
        tagRows: entries.flatMap(toTagRows),
        resolve,
        reject,
      })
      this.#startSaveDrain()
    })
  }

  #startSaveDrain(): void {
    if (this.#drainingSaves !== null) {
      return
    }

    const draining = this.#drainPendingSaves()
    this.#drainingSaves = draining
    void draining.then(() => {
      if (this.#drainingSaves === draining) {
        this.#drainingSaves = null
        if (this.#pendingSaves.length > 0) {
          this.#startSaveDrain()
        }
      }
    })
  }

  async #drainPendingSaves(): Promise<void> {
    for (;;) {
      const save = this.#pendingSaves.shift()
      if (save === undefined) {
        return
      }

      try {
        await this.#client().transaction(async (trx) => {
          for (const chunk of chunked(save.entryRows, INSERT_CHUNK_SIZE)) {
            /*
             * Conflicts are ignored rather than merged. A repeated uuid means the same entry was
             * written twice — for example, an intermediate flush restored entries which a later
             * flush of that context wrote again. Keeping the identical row lets every other entry
             * in the batch proceed.
             */
            await trx.knexQuery().table(ENTRIES_TABLE).insert(chunk).onConflict('uuid').ignore()
          }

          for (const chunk of chunked(save.tagRows, INSERT_CHUNK_SIZE)) {
            await trx
              .knexQuery()
              .table(TAGS_TABLE)
              .insert(chunk)
              .onConflict(['entry_uuid', 'tag'])
              .ignore()
          }
        })
        save.resolve()
      } catch (error) {
        save.reject(error)
      }
    }
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
    const client = this.#client()
    const builder = client.query<EntryRow>().from(ENTRIES_TABLE)

    this.#applyFilters(builder, query, parseEntryCursor(query.cursor), client.dialect.name)

    /*
     * One row more than the page: its existence is the whole answer to "is there a next page?",
     * and it costs one row rather than the `count(*)` over the same predicate that the obvious
     * alternative would need.
     */
    const direction = query.direction === 'asc' ? 'asc' : 'desc'
    const rows = await builder
      .orderBy('sequence', direction)
      .orderBy('uuid', direction)
      .limit(limit + 1)
    const page = rows.slice(0, limit)

    return {
      data: page.map(toStoredEntry),
      nextCursor:
        rows.length > limit
          ? encodeEntryCursor(BigInt(page[page.length - 1].sequence), page[page.length - 1].uuid)
          : null,
    }
  }

  async batch(batchId: string): Promise<StoredEntry[]> {
    // Oldest first: the batch screen is a timeline, the opposite of every index screen.
    const rows = await this.#client()
      .query<EntryRow>()
      .from(ENTRIES_TABLE)
      .where('batch_id', batchId)
      .orderBy('sequence', 'asc')
      .orderBy('uuid', 'asc')

    return rows.map(toStoredEntry)
  }

  async counts(application?: string): Promise<EntryTypeCounts> {
    const builder = this.#client()
      .query<CountRow>()
      .from(ENTRIES_TABLE)
      .select('type')
      .count('* as total')
      .groupBy('type')

    if (application !== undefined) {
      builder.where('application', application)
    }

    const rows = await builder
    const counts: EntryTypeCounts = {}

    for (const row of rows) {
      counts[row.type as EntryType] = Number(row.total)
    }

    return counts
  }

  async requestStats(query: RequestStatsQuery): Promise<RequestStatsResult> {
    type RequestStatsRow = {
      created_at: number | string
      duration: unknown
      status: unknown
      method: unknown
      route_pattern: unknown
      url: unknown
    }

    const client = this.#client()
    const dialect = client.dialect.name
    const fromMs = parseEntryQueryDate(query.from) as number
    const builder = client
      .query<RequestStatsRow>()
      .from(ENTRIES_TABLE)
      .select(
        'created_at',
        client.raw(`${jsonFieldText(dialect, 'content', 'durationMs')} as duration`),
        client.raw(`${jsonFieldText(dialect, 'content', 'status')} as status`),
        client.raw(`${jsonFieldText(dialect, 'content', 'method')} as method`),
        client.raw(`${jsonFieldText(dialect, 'content', 'routePattern')} as route_pattern`),
        client.raw(`${jsonFieldText(dialect, 'content', 'url')} as url`)
      )
      .where('type', EntryType.REQUEST)
      .where('created_at', '>=', fromMs)
      .where('created_at', '<=', parseEntryQueryDate(query.to) as number)
      .orderBy('created_at', 'desc')
      .limit(REQUEST_STATS_MAX_SAMPLES + 1)

    if (query.application !== undefined) {
      builder.where('application', query.application)
    }

    const rows = await builder
    const truncated = rows.length > REQUEST_STATS_MAX_SAMPLES
    const grouped = query.groupBy === 'route'
    const samples = rows.slice(0, REQUEST_STATS_MAX_SAMPLES).map((row) =>
      requestStatsSampleFromRow(
        {
          createdAt: row.created_at,
          duration: row.duration,
          status: row.status,
          method: row.method,
          routePattern: row.route_pattern,
          url: row.url,
        },
        grouped
      )
    )

    return aggregateRequestStats({
      samples,
      fromMs,
      bucketSeconds: query.bucketSeconds,
      grouped,
      truncated,
    })
  }

  async applications(): Promise<ApplicationSummary[]> {
    const rows = await this.#client()
      .query<{
        application: string
        total: number | string
        latest_at: number | string | null
      }>()
      .from(ENTRIES_TABLE)
      .select('application')
      .count('* as total')
      .max('created_at as latest_at')
      .groupBy('application')
      .orderBy('latest_at', 'desc')
      .orderBy('application', 'asc')

    return rows.map((row) => ({
      name: row.application,
      entries: Number(row.total),
      latestAt: row.latest_at === null ? null : new Date(Number(row.latest_at)),
    }))
  }

  async exceptionGroups(query: ExceptionGroupQuery = {}): Promise<Paginated<ExceptionGroup>> {
    type ExceptionGroupRow = {
      family_hash: string
      latest_sequence: string
      total: number | string
    }

    const client = this.#client()
    const limit = resolvePageSize(query.limit)
    const cursor = parseCursor(query.cursor)
    const groupBuilder = client
      .query<ExceptionGroupRow>()
      .from(ENTRIES_TABLE)
      .where('type', EntryType.EXCEPTION)
      .whereNotNull('family_hash')

    if (query.tag !== undefined) {
      const tag = query.tag

      groupBuilder.whereIn('uuid', (subquery) => {
        subquery.from(TAGS_TABLE).select('entry_uuid').where('tag', tag)
      })
    }

    if (query.application !== undefined) {
      groupBuilder.where('application', query.application)
    }

    groupBuilder
      .select('family_hash')
      .max('sequence as latest_sequence')
      .count('* as total')
      .groupBy('family_hash')

    if (cursor !== null) {
      groupBuilder.havingRaw('max(sequence) < ?', [encodeSequence(cursor)])
    }

    const groups = await groupBuilder.orderBy('latest_sequence', 'desc').limit(limit + 1)
    const page = groups.slice(0, limit)

    if (page.length === 0) {
      return { data: [], nextCursor: null }
    }

    const entryBuilder = client
      .query<EntryRow>()
      .from(ENTRIES_TABLE)
      .whereIn(
        'sequence',
        page.map(({ latest_sequence: sequence }) => sequence)
      )
    this.#applyFilters(entryBuilder, query, null, client.dialect.name)

    const rows = await entryBuilder
    const latestByFamily = new Map(
      rows.map((row) => [`${row.family_hash}\u0000${row.sequence}`, toStoredEntry(row)])
    )
    const data: ExceptionGroup[] = []

    for (const group of page) {
      const latest = latestByFamily.get(`${group.family_hash}\u0000${group.latest_sequence}`)

      if (latest !== undefined) {
        data.push({
          familyHash: group.family_hash,
          latest,
          count: Number(group.total),
          lastSeen: new Date(latest.createdAt.getTime()),
        })
      }
    }

    return {
      data,
      nextCursor:
        groups.length > limit ? encodeCursor(BigInt(page[page.length - 1].latest_sequence)) : null,
    }
  }

  async prune(options: PruneOptions): Promise<number> {
    const before = options.before.getTime()
    const keepExceptions = options.keepExceptions === true

    return this.#client().transaction(async (trx) => {
      await trx
        .query()
        .from(FLAGS_TABLE)
        .whereNotNull('expires_at')
        .where('expires_at', '<=', Date.now())
        .del()

      return this.#deleteEntries(trx, (builder) => {
        builder.where('created_at', '<', before)

        if (keepExceptions) {
          builder.whereNot('type', EntryType.EXCEPTION)
        }

        if (options.application !== undefined) {
          builder.where('application', options.application)
        }
      })
    })
  }

  async trim(maxEntries: number): Promise<number> {
    const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 0
    const client = this.#client()
    await client
      .query()
      .from(FLAGS_TABLE)
      .whereNotNull('expires_at')
      .where('expires_at', '<=', Date.now())
      .del()

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
       * The survivors are defined by the cap, inside the transaction: take the composite
       * `(sequence, uuid)` key of the `cap`-th newest entry and delete everything below it.
       * Whatever else ran in the meantime, exactly the newest `cap` entries remain. The answer is
       * one boundary pair rather than a `where uuid in (...)` listing every doomed row, which at
       * trim scale would blow SQLite's bind-parameter ceiling and hold a few hundred thousand
       * uuids in memory to do it.
       */
      const boundary = await trx
        .query<{ sequence: string; uuid: string }>()
        .from(ENTRIES_TABLE)
        .select('sequence', 'uuid')
        .orderBy('sequence', 'desc')
        .orderBy('uuid', 'desc')
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
        builder.whereRaw('(sequence < ? or (sequence = ? and uuid < ?))', [
          oldestKept,
          oldestKept,
          boundary.uuid,
        ])
      })
    })
  }

  async clear(application?: string): Promise<void> {
    /*
     * A delete rather than a truncate. `truncate` is DDL on some dialects (implicitly committing
     * an open transaction), needs `cascade` on postgres to get past the foreign key, and resets
     * identity columns nobody asked it to touch. Monitored tags and flags remain user intent.
     */
    await this.#client().transaction(async (trx) => {
      const select = (builder: DatabaseQueryBuilderContract<EntryRow>) => {
        if (application !== undefined) {
          builder.where('application', application)
        }
      }
      await this.#deleteEntries(trx, select)
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
      .knexQuery()
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

  async hasFlagWithPrefix(prefix: string): Promise<boolean> {
    /*
     * `!` is the escape character because backslash string-literal rules differ between postgres
     * and MySQL. Escaping makes the contract a literal starts-with query, not wildcard access.
     */
    const pattern = `${prefix.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`
    const row = await this.#client()
      .query()
      .from(FLAGS_TABLE)
      .select('name')
      .whereRaw("name like ? escape '!'", [pattern])
      .whereRaw('(expires_at is null or expires_at > ?)', [Date.now()])
      .first()

    return row !== null && row !== undefined
  }

  async setFlag(name: string, value: string, options: FlagOptions = {}): Promise<void> {
    const expiresAt = options.expiresAt === undefined ? null : options.expiresAt.getTime()

    /*
     * `merge` lists both columns explicitly, so setting a flag without an expiry writes `null`
     * over whatever expiry the previous value carried. Merging only `value` would leave a stale
     * expiry behind and make a freshly set flag read back as absent.
     */
    await this.#client()
      .knexQuery()
      .table(FLAGS_TABLE)
      .insert({ name, value, expires_at: expiresAt })
      .onConflict('name')
      .merge(['value', 'expires_at'])
  }

  async deleteFlag(name: string): Promise<void> {
    await this.#client().query().from(FLAGS_TABLE).where('name', name).del()
  }

  /**
   * Wait for the bounded write queue to settle without closing the host application's connection.
   * Repeated calls are safe, and a batch already being written remains owned until its caller has
   * observed success or failure.
   */
  async close(): Promise<void> {
    while (this.#drainingSaves !== null) {
      await this.#drainingSaves
    }
  }
}
