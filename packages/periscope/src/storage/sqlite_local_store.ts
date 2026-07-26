/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'
import type { Database as DatabaseHandle, Statement } from 'better-sqlite3'

import { PeriscopeStorageError } from '../errors.ts'
import { EntryType } from '../types.ts'
import type {
  EntryQuery,
  EntryTypeCounts,
  ExceptionGroup,
  ExceptionGroupQuery,
  FlagOptions,
  Paginated,
  PeriscopeStore,
  PruneOptions,
  StoredEntry,
} from '../types.ts'
import { encodeCursor, parseCursor, resolvePageSize } from './pagination.ts'
import { aggregateExceptionGroups } from './exception_groups.ts'
import {
  ENTRIES_TABLE,
  FLAGS_TABLE,
  INSERT_CHUNK_SIZE,
  MONITORED_TAGS_TABLE,
  TAGS_TABLE,
  TAG_INDEX_MAX_LENGTH,
  encodeSequence,
  toEntryRow,
  toStoredEntry,
  toTagRows,
} from './sql.ts'
import type { EntryRow, TagRow } from './sql.ts'

/**
 * Everything better-sqlite3 will bind. The driver refuses a JavaScript `boolean`, a `Date`, a
 * plain object and `undefined` — it throws `TypeError: value ... is invalid` rather than coercing
 * — so spelling the union out and typing every prepared statement with it turns "never bind a
 * boolean" from a rule someone has to remember into one the compiler enforces. The codecs in
 * `./sql.ts` already produce exactly this set.
 */
type Binding = string | number | bigint | Buffer | null

/**
 * The entry columns, in the one order both the insert statement and the row type use. Written
 * once so a column added to {@link EntryRow} cannot be bound into the wrong slot.
 */
const ENTRY_COLUMNS =
  'uuid, batch_id, type, family_hash, content, tags, should_display_on_index, sequence, created_at'

/**
 * Bind slots per entry row — the column count of {@link ENTRY_COLUMNS}.
 */
const ENTRY_COLUMN_COUNT = 9

/**
 * How long a statement waits for a lock held by another connection before giving up.
 *
 * Two processes routinely have this file open: `node ace serve` writing entries and
 * `node ace periscope:prune` (or a second dashboard) deleting them. WAL lets them read
 * concurrently but still serialises writers, so a prune commit can hold the write lock for a
 * moment. Five seconds is far longer than any statement here takes and turns what would be an
 * immediate `SQLITE_BUSY` into a short wait; the alternative — failing the flush — loses entries
 * for no reason.
 */
const BUSY_TIMEOUT_MS = 5_000

/**
 * The schema, created on first open.
 *
 * There are no migrations, and that is the feature: this file lives under `tmp/`, holds nothing
 * but debug data, and deleting it must be a complete and supported reset. `if not exists`
 * everywhere is what makes "delete the file and restart" work, and what makes opening an existing
 * file from an older run cost nothing.
 *
 * Column types follow the module note in `./sql.ts`: `sequence` is fixed-width text so it sorts
 * as the number it encodes, `created_at` is epoch milliseconds in SQLite's 64-bit `integer`, and
 * `should_display_on_index` is `0`/`1` rather than a boolean the driver would refuse to bind.
 *
 * Every primary-key column is spelled `not null`, which sounds redundant and is not: SQLite only
 * enforces it on an `integer primary key`, and every other type keeps the historical bug where
 * the column happily stores NULL. Without it `uuid`, `tag` and `name` would be nullable here
 * while `./database_schema.ts` declares them `not null` on every other dialect — two schemas
 * behind one store, disagreeing about what a row may hold.
 */
const SCHEMA = `
create table if not exists ${ENTRIES_TABLE} (
  uuid varchar(36) not null primary key,
  batch_id varchar(36) not null,
  type varchar(32) not null,
  family_hash varchar(64),
  content text not null,
  tags text not null,
  should_display_on_index integer not null,
  sequence varchar(20) not null,
  created_at integer not null
);

create index if not exists periscope_entries_sequence_index
  on ${ENTRIES_TABLE} (sequence);
create index if not exists periscope_entries_type_display_index
  on ${ENTRIES_TABLE} (type, should_display_on_index, sequence);
create index if not exists periscope_entries_batch_id_index
  on ${ENTRIES_TABLE} (batch_id, sequence);
create index if not exists periscope_entries_family_hash_index
  on ${ENTRIES_TABLE} (family_hash);
create index if not exists periscope_entries_created_at_index
  on ${ENTRIES_TABLE} (created_at);

create table if not exists ${TAGS_TABLE} (
  entry_uuid varchar(36) not null references ${ENTRIES_TABLE} (uuid) on delete cascade,
  tag varchar(${TAG_INDEX_MAX_LENGTH}) not null,
  primary key (entry_uuid, tag)
);

create index if not exists periscope_entry_tags_tag_index
  on ${TAGS_TABLE} (tag);

create table if not exists ${MONITORED_TAGS_TABLE} (
  tag varchar(${TAG_INDEX_MAX_LENGTH}) not null primary key
);

create table if not exists ${FLAGS_TABLE} (
  -- Not a tag: this width only mirrors database_schema.ts so the two schemas stay identical.
  name varchar(191) not null primary key,
  value text not null,
  expires_at integer
);
`

/**
 * Options accepted by {@link SqliteLocalStore}.
 */
export type SqliteLocalStoreOptions = {
  /**
   * Absolute path to the database file. The provider passes `app.tmpPath('periscope.sqlite')`;
   * the parent directory is created if it does not exist yet.
   */
  path: string
}

/**
 * `(?, ?, ...)` groups for a multi-row insert.
 *
 * The generated text is also the prepared-statement cache key, so the two shapes a chunked save
 * produces — full chunks and one remainder — cost two prepares for the lifetime of the process
 * rather than two per save.
 */
function placeholders(rows: number, columns: number): string {
  const group = `(${'?, '.repeat(columns - 1)}?)`

  return rows === 1 ? group : new Array<string>(rows).fill(group).join(', ')
}

/**
 * Open the database file and bring it up to a state the store can use: directory, connection,
 * pragmas, schema.
 *
 * Every failure in here is a boot-time failure — an unwritable `tmp/`, a directory where the file
 * should be, a corrupt header — and the one place Periscope is allowed to be loud (see
 * `../errors.ts`). Recording that silently goes nowhere is worse than a process that refuses to
 * start with the path in the message.
 */
function openDatabase(path: string): DatabaseHandle {
  /*
   * Declared out here so the catch can reach it. Everything after `new Database` — three pragmas
   * and the schema — can throw on a file that exists but is not a database, or is a database an
   * older, incompatible run left behind, and a handle abandoned inside the try keeps its file
   * descriptor and its SQLite lock for the life of the process. The boot that failed is then
   * followed by a retry that cannot succeed either, because the first attempt is still holding
   * the file.
   */
  let db: DatabaseHandle | undefined

  try {
    mkdirSync(dirname(path), { recursive: true })

    db = new Database(path)

    /*
     * WAL, because the dashboard reads the same file the application is writing. Under the
     * default rollback journal a writer blocks every reader, which would make a dashboard refresh
     * stall behind a flush; under WAL readers never block and never see a half-written batch.
     * It is also persistent — set once into the file header, honoured by every later connection,
     * including the prune command's.
     */
    db.pragma('journal_mode = WAL')
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)

    /*
     * `synchronous = NORMAL` is the right trade for this file specifically. `FULL` fsyncs the WAL
     * on every commit, which is the cost that makes SQLite feel slow, and it buys durability of
     * the last few commits across a power cut or kernel panic. What is at stake here is a handful
     * of debug entries from a dev machine that just lost power — the recorder will happily record
     * more the moment it restarts. NORMAL still fsyncs at every checkpoint and is documented as
     * safe against application and OS crashes in WAL mode; only a hardware-level loss can leave a
     * torn tail, and losing it costs nothing anyone will notice.
     */
    db.pragma('synchronous = NORMAL')

    /*
     * Foreign keys are off by default in SQLite and are per connection, not per file. Turning
     * them on makes the tag table's `on delete cascade` real for anything that deletes an entry
     * without going through this store — a human with a `sqlite3` shell, most likely. The store
     * itself still deletes tag rows explicitly, because the `database` driver runs against a
     * connection Periscope does not own and cannot make the same guarantee; keeping both drivers
     * on the explicit path is what keeps them behaving identically.
     */
    db.pragma('foreign_keys = ON')

    db.exec(SCHEMA)

    return db
  } catch (error) {
    db?.close()

    const reason = error instanceof Error ? error.message : String(error)

    /*
     * The remedy matters as much as the cause. This is the first thing an application sees when
     * its `tmp/` is missing, read-only or on a filesystem SQLite cannot lock, and the two ways
     * out are the two named here — the same shape `./resolve.ts` uses for the `database` driver.
     */
    throw new PeriscopeStorageError(
      `Periscope could not open its SQLite database at "${path}": ${reason}. ` +
        `Make sure "${dirname(path)}" exists and is writable, or set storage.driver to ` +
        '"memory" in config/periscope.ts to keep Periscope out of the filesystem.',
      { cause: error }
    )
  }
}

/**
 * The `sqlite-local` storage driver (implementation plan P2.2): a dedicated better-sqlite3 file,
 * usually `tmp/periscope.sqlite`.
 *
 * This is the zero-config default. It talks to better-sqlite3 directly rather than through Lucid
 * or knex, which is the whole point of it: an API-only application with no database of its own
 * still gets persistent, restart-surviving history, and Periscope's own storage never shows up in
 * the application's migrations, connection pool or query log. (The `database` driver is for
 * applications that would rather keep everything in one place.)
 *
 * Two design notes are worth the paragraphs, because both look like mistakes from the outside:
 *
 * - **The interface is async, the driver is not.** better-sqlite3 is synchronous by design — it
 *   is faster than an async driver for this workload precisely because there is no thread pool
 *   hop. `save` is nonetheless async-honest: it yields to the event loop *before* touching the
 *   database, so a flush of a few hundred rows can never run inline with whatever microtask
 *   called it. The recorder already took the flush off the request's hot path; this keeps the
 *   promise the interface makes literally true rather than nominally. Reads deliberately do not
 *   yield. They serve one dashboard request for one page of at most a thousand rows, an index
 *   scan that costs microseconds, and an extra `setImmediate` per read would only add a tick of
 *   latency to buy nothing.
 *
 * - **Statements are prepared once and cached by their SQL text.** Prepared `Statement` objects
 *   are where better-sqlite3's speed comes from, and re-preparing on every call throws it away.
 *   Keying the cache on the SQL string means the statements whose text varies — `list`, whose
 *   `where` clause depends on which filters are set, and the chunked inserts, whose placeholder
 *   count depends on the chunk — cache themselves without a second mechanism. The key space is
 *   bounded by the number of *filter shapes*, not by the number of queries: a few dozen strings
 *   for the lifetime of the process.
 */
export class SqliteLocalStore implements PeriscopeStore {
  readonly #db: DatabaseHandle

  /**
   * Prepared statements by SQL text. See the class note; `Result` is erased on the way in and
   * restored by {@link SqliteLocalStore.#prepare}, which is the one place that knows both.
   */
  readonly #statements = new Map<string, Statement<Binding[]>>()

  /**
   * The mutating operations, each wrapped once in a better-sqlite3 transaction. `db.transaction`
   * returns a function, so the wrappers are built here rather than rebuilt per call.
   */
  readonly #saveAll: (entries: StoredEntry[]) => void
  readonly #pruneBefore: (before: number, keepExceptions: boolean) => number
  readonly #trimTo: (cap: number) => number
  readonly #clearAll: () => void

  constructor(options: SqliteLocalStoreOptions) {
    this.#db = openDatabase(options.path)

    this.#saveAll = this.#db.transaction((entries: StoredEntry[]) => {
      this.#insertEntries(entries)
      this.#insertTags(entries)
    })

    this.#pruneBefore = this.#db.transaction((before: number, keepExceptions: boolean) => {
      const filter = keepExceptions ? 'created_at < ? and type <> ?' : 'created_at < ?'
      const values: Binding[] = keepExceptions ? [before, EntryType.EXCEPTION] : [before]

      /*
       * Tag rows go first and explicitly: they are selected through the entries that are about to
       * disappear, so deleting the entries first would leave nothing to select them by. The
       * foreign key would cascade here, but see `openDatabase` for why neither driver leans on
       * that.
       */
      this.#prepare(
        `delete from ${TAGS_TABLE} where entry_uuid in (select uuid from ${ENTRIES_TABLE} where ${filter})`
      ).run(...values)

      return this.#prepare(`delete from ${ENTRIES_TABLE} where ${filter}`).run(...values).changes
    })

    /*
     * Self-limiting by the cap, rather than by an excess measured outside the transaction. Every
     * process running the application trims on its own flush schedule, so two of them routinely
     * measure the same excess against the same file; a delete that trusted that number would cut
     * it twice and leave `cap - excess` rows behind. Phrasing the survivors as "the newest `cap`
     * entries" makes the second, concurrent trim a no-op instead of a second cut, whatever it
     * counted a moment ago.
     *
     * `immediate` rather than the default deferred begin: the write lock is taken at `begin`, so
     * the rows the subquery picks are the rows the delete removes, and no reader-then-writer
     * snapshot can be left behind by another process committing between the two statements.
     */
    this.#trimTo = this.#db.transaction((cap: number) => {
      // `limit -1` is SQLite's "no upper bound", which is what makes `offset` usable on its own:
      // skip the newest `cap` entries, take every entry older than them.
      const doomed = `select uuid from ${ENTRIES_TABLE} order by sequence desc limit -1 offset ?`

      this.#prepare(`delete from ${TAGS_TABLE} where entry_uuid in (${doomed})`).run(cap)

      return this.#prepare(`delete from ${ENTRIES_TABLE} where uuid in (${doomed})`).run(cap)
        .changes
    }).immediate

    this.#clearAll = this.#db.transaction(() => {
      this.#prepare(`delete from ${TAGS_TABLE}`).run()
      this.#prepare(`delete from ${ENTRIES_TABLE}`).run()
    })
  }

  /**
   * Fetch — or prepare and cache — the statement for one piece of SQL.
   *
   * The cast is the price of one cache holding statements with different row shapes: the map
   * cannot be generic, and better-sqlite3 hands back rows it has no way to type either. Every
   * caller passes the `Result` matching the columns its own SQL selects, and `toStoredEntry`
   * defends the entry shape against a row that somehow is not what it claims.
   */
  #prepare<Result = unknown>(sql: string): Statement<Binding[], Result> {
    let statement = this.#statements.get(sql)

    if (statement === undefined) {
      statement = this.#db.prepare<Binding[]>(sql)
      this.#statements.set(sql, statement)
    }

    return statement as unknown as Statement<Binding[], Result>
  }

  /**
   * Insert the entry rows of one batch, `INSERT_CHUNK_SIZE` rows per statement.
   *
   * `insert or ignore` rather than an upsert: a save retried after a partially applied
   * transaction, or a batch replayed by a flush that already succeeded, must not fail the rows
   * around the duplicate. Keeping the stored version also keeps the tag rows below consistent
   * with it — an upsert would rewrite the entry while its old tags stayed indexed.
   */
  #insertEntries(entries: StoredEntry[]): void {
    for (let offset = 0; offset < entries.length; offset += INSERT_CHUNK_SIZE) {
      const end = Math.min(offset + INSERT_CHUNK_SIZE, entries.length)
      const values: Binding[] = []

      for (let index = offset; index < end; index += 1) {
        const row = toEntryRow(entries[index])

        /*
         * `EntryRow` is typed for the *read* side, where dialects disagree about what comes back;
         * `toEntryRow` only ever produces the narrow write shape, which is what these assertions
         * record. `created_at` is normalised rather than asserted because epoch milliseconds are
         * well inside `Number.MAX_SAFE_INTEGER` and SQLite stores the integer either way.
         */
        values.push(
          row.uuid,
          row.batch_id,
          row.type,
          row.family_hash,
          row.content as string,
          row.tags as string,
          row.should_display_on_index as number,
          row.sequence,
          Number(row.created_at)
        )
      }

      this.#prepare(
        `insert or ignore into ${ENTRIES_TABLE} (${ENTRY_COLUMNS}) values ${placeholders(end - offset, ENTRY_COLUMN_COUNT)}`
      ).run(...values)
    }
  }

  /**
   * Insert the tag lookup rows for a batch. The rows are collected across the whole batch before
   * chunking so that a batch of many lightly tagged entries still fills a statement.
   */
  #insertTags(entries: StoredEntry[]): void {
    const rows: TagRow[] = []

    for (const entry of entries) {
      for (const row of toTagRows(entry)) {
        rows.push(row)
      }
    }

    for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
      const end = Math.min(offset + INSERT_CHUNK_SIZE, rows.length)
      const values: Binding[] = []

      for (let index = offset; index < end; index += 1) {
        values.push(rows[index].entry_uuid, rows[index].tag)
      }

      this.#prepare(
        `insert or ignore into ${TAGS_TABLE} (entry_uuid, tag) values ${placeholders(end - offset, 2)}`
      ).run(...values)
    }
  }

  /**
   * Build the `select` behind {@link SqliteLocalStore.list}: one `where` fragment per filter that
   * was actually set, so an unfiltered query stays an index scan rather than a chain of
   * `1 = 1`s.
   *
   * The tag filter is an `exists` subquery, never a join. A join against the tag table would
   * return one row per matching tag and quietly duplicate entries the day a query filters on a
   * tag an entry carries twice.
   */
  #selectEntries(query: EntryQuery, cursor: bigint | null): { sql: string; values: Binding[] } {
    const conditions: string[] = []
    const values: Binding[] = []

    if (query.type !== undefined) {
      conditions.push('type = ?')
      values.push(query.type)
    }

    if (query.tag !== undefined) {
      conditions.push(
        `exists (select 1 from ${TAGS_TABLE} where ${TAGS_TABLE}.entry_uuid = ${ENTRIES_TABLE}.uuid and ${TAGS_TABLE}.tag = ?)`
      )
      values.push(query.tag)
    }

    if (query.familyHash !== undefined) {
      conditions.push('family_hash = ?')
      values.push(query.familyHash)
    }

    if (query.batchId !== undefined) {
      conditions.push('batch_id = ?')
      values.push(query.batchId)
    }

    if (query.displayOnIndex !== undefined) {
      conditions.push('should_display_on_index = ?')
      values.push(query.displayOnIndex ? 1 : 0)
    }

    if (cursor !== null) {
      conditions.push('sequence < ?')
      values.push(encodeSequence(cursor))
    }

    const where = conditions.length === 0 ? '' : ` where ${conditions.join(' and ')}`

    return {
      sql: `select ${ENTRY_COLUMNS} from ${ENTRIES_TABLE}${where} order by sequence desc limit ?`,
      values,
    }
  }

  async save(entries: StoredEntry[]): Promise<void> {
    if (entries.length === 0) {
      return
    }

    /*
     * The yield that makes this driver async-honest — see the class note. It happens before the
     * transaction rather than after it so the caller's synchronous continuation runs first: a
     * flush of several hundred rows is the one operation here big enough to be worth not doing
     * inline, and `setImmediate` puts it in the check phase, after any pending I/O callback the
     * application is actually waiting on.
     */
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })

    this.#saveAll(entries)
  }

  async find(uuid: string): Promise<StoredEntry | null> {
    const row = this.#prepare<EntryRow>(
      `select ${ENTRY_COLUMNS} from ${ENTRIES_TABLE} where uuid = ?`
    ).get(uuid)

    return row === undefined ? null : toStoredEntry(row)
  }

  async list(query: EntryQuery = {}): Promise<Paginated<StoredEntry>> {
    const limit = resolvePageSize(query.limit)
    const { sql, values } = this.#selectEntries(query, parseCursor(query.cursor))

    /*
     * One row more than the page: its existence — and only its existence — is what says another
     * page follows, so a caller walking pages never fetches an empty one to discover it is done.
     */
    const rows = this.#prepare<EntryRow>(sql).all(...values, limit + 1)
    const overflowed = rows.length > limit
    const data: StoredEntry[] = []

    for (let index = 0; index < rows.length && index < limit; index += 1) {
      data.push(toStoredEntry(rows[index]))
    }

    return {
      data,
      nextCursor: overflowed ? encodeCursor(data[data.length - 1].sequence) : null,
    }
  }

  async batch(batchId: string): Promise<StoredEntry[]> {
    // Oldest first: the batch screen is a timeline, the opposite of every index screen.
    const rows = this.#prepare<EntryRow>(
      `select ${ENTRY_COLUMNS} from ${ENTRIES_TABLE} where batch_id = ? order by sequence asc`
    ).all(batchId)

    return rows.map(toStoredEntry)
  }

  async counts(): Promise<EntryTypeCounts> {
    const rows = this.#prepare<{ type: EntryType; total: number }>(
      `select type, count(*) as total from ${ENTRIES_TABLE} group by type`
    ).all()

    const counts: EntryTypeCounts = {}

    for (const row of rows) {
      counts[row.type] = row.total
    }

    return counts
  }

  async exceptionGroups(query: ExceptionGroupQuery = {}): Promise<Paginated<ExceptionGroup>> {
    const conditions = ['type = ?', 'family_hash is not null']
    const values: Binding[] = [EntryType.EXCEPTION]

    if (query.tag !== undefined) {
      conditions.push(
        `exists (select 1 from ${TAGS_TABLE} where ${TAGS_TABLE}.entry_uuid = ${ENTRIES_TABLE}.uuid and ${TAGS_TABLE}.tag = ?)`
      )
      values.push(query.tag)
    }

    const rows = this.#prepare<EntryRow>(
      `select ${ENTRY_COLUMNS} from ${ENTRIES_TABLE} where ${conditions.join(' and ')}`
    ).all(...values)

    return aggregateExceptionGroups(rows.map(toStoredEntry), query)
  }

  async prune(options: PruneOptions): Promise<number> {
    return this.#pruneBefore(options.before.getTime(), options.keepExceptions === true)
  }

  async trim(maxEntries: number): Promise<number> {
    const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 0

    /*
     * Counting first is what lets the common case — a store already under the cap, which is every
     * call but the occasional one — cost a single index-only count instead of opening a write
     * transaction to delete nothing.
     *
     * That is the whole of its job. The count runs in autocommit and is stale the moment it is
     * read, so it decides only whether to open the transaction; what to delete is decided inside
     * the transaction, against the cap.
     */
    const total = this.#prepare<{ total: number }>(
      `select count(*) as total from ${ENTRIES_TABLE}`
    ).get()

    return (total?.total ?? 0) <= cap ? 0 : this.#trimTo(cap)
  }

  async clear(): Promise<void> {
    this.#clearAll()
  }

  async monitoredTags(): Promise<string[]> {
    // Ordered so the dashboard's list does not reshuffle itself between two identical requests.
    const rows = this.#prepare<{ tag: string }>(
      `select tag from ${MONITORED_TAGS_TABLE} order by tag asc`
    ).all()

    return rows.map((row) => row.tag)
  }

  async monitorTag(tag: string): Promise<void> {
    this.#prepare(`insert or ignore into ${MONITORED_TAGS_TABLE} (tag) values (?)`).run(tag)
  }

  async unmonitorTag(tag: string): Promise<void> {
    this.#prepare(`delete from ${MONITORED_TAGS_TABLE} where tag = ?`).run(tag)
  }

  async getFlag(name: string): Promise<string | null> {
    const row = this.#prepare<{ value: string; expires_at: number | null }>(
      `select value, expires_at from ${FLAGS_TABLE} where name = ?`
    ).get(name)

    if (row === undefined) {
      return null
    }

    /*
     * Expiry is lazy: no timer to leak, no wheel to drain at shutdown, and no second process
     * needed to collect the row — whichever process reads the expired flag next deletes it.
     */
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      await this.deleteFlag(name)

      return null
    }

    return row.value
  }

  async hasFlagWithPrefix(prefix: string): Promise<boolean> {
    const pattern = `${prefix.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`
    const row = this.#prepare<{ present: number }>(
      `select 1 as present from ${FLAGS_TABLE}
       where name like ? escape '!' and (expires_at is null or expires_at > ?)
       limit 1`
    ).get(pattern, Date.now())

    return row !== undefined
  }

  async setFlag(name: string, value: string, options: FlagOptions = {}): Promise<void> {
    // Both columns are overwritten, so setting a flag without an expiry clears the one it had.
    this.#prepare(
      `insert into ${FLAGS_TABLE} (name, value, expires_at) values (?, ?, ?)
       on conflict (name) do update set value = excluded.value, expires_at = excluded.expires_at`
    ).run(name, value, options.expiresAt?.getTime() ?? null)
  }

  async deleteFlag(name: string): Promise<void> {
    this.#prepare(`delete from ${FLAGS_TABLE} where name = ?`).run(name)
  }

  /**
   * Close the connection, checkpointing the WAL and releasing the file lock so a prune command or
   * a second dev server can take it.
   *
   * Idempotent through `db.open`, because shutdown can genuinely run twice — a test closing
   * explicitly and then the provider closing again — and better-sqlite3 throws on a second
   * `close()`. Dropping the statement cache is not strictly required (closing the database
   * finalises them) but it keeps a closed store from pinning a few dozen dead handles.
   */
  async close(): Promise<void> {
    if (!this.#db.open) {
      return
    }

    this.#statements.clear()
    this.#db.close()
  }
}
