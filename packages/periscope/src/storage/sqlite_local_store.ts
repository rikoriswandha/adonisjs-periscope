/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { closeSync, constants, mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'
import type { Database as DatabaseHandle, Statement } from 'better-sqlite3'

import { PeriscopeStorageError } from '../errors.ts'
import { EntryType } from '../types.ts'
import type {
  ApplicationSummary,
  EntryQuery,
  EntryTypeCounts,
  ExceptionGroup,
  ExceptionGroupQuery,
  FlagOptions,
  Paginated,
  PeriscopeStore,
  PruneOptions,
  RequestStatsQuery,
  RequestStatsResult,
  StoredEntry,
  StoredFlag,
  StoreDiagnostics,
} from '../types.ts'
import {
  encodeCursor,
  encodeEntryCursor,
  parseCursor,
  parseEntryCursor,
  resolvePageSize,
} from './pagination.ts'
import {
  ENTRIES_TABLE,
  ENTRIES_FTS_TABLE,
  FLAGS_TABLE,
  INSERT_CHUNK_SIZE,
  MONITORED_TAGS_TABLE,
  TAGS_TABLE,
  TAG_INDEX_MAX_LENGTH,
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
import type { EntryCursor } from './pagination.ts'
import {
  aggregateRequestStats,
  REQUEST_STATS_MAX_SAMPLES,
  requestStatsSampleFromRow,
} from './request_stats.ts'

/**
 * Everything better-sqlite3 will bind. The driver refuses a JavaScript `boolean`, a `Date`, a
 * plain object and `undefined` — it throws `TypeError: value ... is invalid` rather than coercing
 * — so spelling the union out and typing every prepared statement with it turns "never bind a
 * boolean" from a rule someone has to remember into one the compiler enforces. The codecs in
 * `./sql.ts` already produce exactly this set.
 */
type Binding = string | number | bigint | Buffer | null

interface PendingSave {
  entries: StoredEntry[]
  resolve(): void
  reject(error: unknown): void
}

/**
 * The entry columns, in the one order both the insert statement and the row type use. Written
 * once so a column added to {@link EntryRow} cannot be bound into the wrong slot.
 */
const ENTRY_COLUMNS =
  'uuid, batch_id, application, type, family_hash, content, tags, should_display_on_index, sequence, created_at'

/**
 * Bind slots per entry row — the column count of {@link ENTRY_COLUMNS}.
 */
const ENTRY_COLUMN_COUNT = 10

/**
 * How often {@link SqliteLocalStore.trim} sweeps expired flags and re-reads `count(*)` from the
 * file. Between sweeps the ceiling check runs against the in-process count, so a flush costs no
 * SQL when the store is under its cap; the interval bounds both how long an expired flag row can
 * linger and how long another process's inserts can go unseen by this one's ceiling.
 */
const MAINTENANCE_INTERVAL_MS = 30_000

/**
 * better-sqlite3 waits synchronously on the event-loop thread. WAL keeps normal reads concurrent,
 * while this short ceiling makes the save fail fast so the recorder can restore the fragment to
 * its context instead of freezing the host for seconds when another process holds the writer
 * lock. The fragment is retried only when that context still has another flush coming.
 */
const BUSY_TIMEOUT_MS = 100

/**
 * One batch is one recorder flush. Bounding this queue prevents a blocked SQLite writer from
 * turning telemetry into an application-wide memory leak; the oldest telemetry is least useful
 * when fresh batches are still arriving.
 */
const SAVE_BACKLOG_LIMIT = 256

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
  application varchar(191) not null default 'default',
  type varchar(32) not null,
  family_hash varchar(64),
  content text not null,
  tags text not null,
  should_display_on_index integer not null,
  sequence varchar(20) not null,
  created_at integer not null
);

create index if not exists periscope_entries_sequence_index
  on ${ENTRIES_TABLE} (sequence, uuid);
create index if not exists periscope_entries_type_display_index
  on ${ENTRIES_TABLE} (type, should_display_on_index, sequence, uuid);
create index if not exists periscope_entries_batch_id_index
  on ${ENTRIES_TABLE} (batch_id, sequence, uuid);
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
  application varchar(191) not null default 'default',
  tag varchar(${TAG_INDEX_MAX_LENGTH}) not null,
  primary key (application, tag)
);

create table if not exists ${FLAGS_TABLE} (
  -- Not a tag: this width only mirrors database_schema.ts so the two schemas stay identical.
  name varchar(191) not null primary key,
  value text not null,
  expires_at integer
);
`

const APPLICATION_INDEXES = `
create index if not exists periscope_entries_application_type_display_index
  on ${ENTRIES_TABLE} (application, type, should_display_on_index, sequence, uuid);
create index if not exists periscope_entries_application_sequence_index
  on ${ENTRIES_TABLE} (application, sequence, uuid);
`

const FTS_INSERT_TRIGGER = 'periscope_entries_fts_insert'
const FTS_DELETE_TRIGGER = 'periscope_entries_fts_delete'
const FTS_UPDATE_TRIGGER = 'periscope_entries_fts_update'

/**
 * An external-content trigram index gives `MATCH` the same literal-substring semantics as the
 * other stores without duplicating the serialized payload. Triggers live in the database, so
 * writes from another process stay indexed too.
 */
const FTS_SCHEMA = `
create virtual table if not exists ${ENTRIES_FTS_TABLE} using fts5(
  content,
  content='${ENTRIES_TABLE}',
  content_rowid='rowid',
  tokenize='trigram'
);

create trigger if not exists ${FTS_INSERT_TRIGGER}
after insert on ${ENTRIES_TABLE} begin
  insert into ${ENTRIES_FTS_TABLE} (rowid, content) values (new.rowid, new.content);
end;

create trigger if not exists ${FTS_DELETE_TRIGGER}
after delete on ${ENTRIES_TABLE} begin
  insert into ${ENTRIES_FTS_TABLE} (${ENTRIES_FTS_TABLE}, rowid, content)
  values ('delete', old.rowid, old.content);
end;

create trigger if not exists ${FTS_UPDATE_TRIGGER}
after update of content on ${ENTRIES_TABLE} begin
  insert into ${ENTRIES_FTS_TABLE} (${ENTRIES_FTS_TABLE}, rowid, content)
  values ('delete', old.rowid, old.content);
  insert into ${ENTRIES_FTS_TABLE} (rowid, content) values (new.rowid, new.content);
end;
`

const DROP_FTS_TRIGGERS = `
drop trigger if exists ${FTS_INSERT_TRIGGER};
drop trigger if exists ${FTS_DELETE_TRIGGER};
drop trigger if exists ${FTS_UPDATE_TRIGGER};
`

/**
 * Tracks handles on which FTS setup succeeded without exposing connection details on the store.
 * A WeakSet lets closed databases be collected normally.
 */
const FTS_ENABLED_DATABASES = new WeakSet<DatabaseHandle>()

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
 * Create (or repair) the optional full-text index. `rebuild` backfills databases created by an
 * older Periscope release before the virtual table and triggers existed; established indexes
 * avoid paying that scan again on every process start.
 */
function initializeFullTextSearch(db: DatabaseHandle): void {
  try {
    const schemaObjects = db
      .prepare<[], { name: string }>(
        `select name from sqlite_master where name in (
          '${ENTRIES_FTS_TABLE}',
          '${FTS_INSERT_TRIGGER}',
          '${FTS_DELETE_TRIGGER}',
          '${FTS_UPDATE_TRIGGER}'
        )`
      )
      .all()
    const needsRebuild = schemaObjects.length !== 4

    db.exec(FTS_SCHEMA)
    if (needsRebuild) {
      db.prepare(`insert into ${ENTRIES_FTS_TABLE} (${ENTRIES_FTS_TABLE}) values ('rebuild')`).run()
    }

    // Force SQLite to load the module even when every schema object already existed.
    db.prepare(
      `select rowid from ${ENTRIES_FTS_TABLE} where ${ENTRIES_FTS_TABLE} match ? limit 0`
    ).all('periscope')
    FTS_ENABLED_DATABASES.add(db)
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()

    if (reason.includes('no such module: fts5') || reason.includes('no such tokenizer: trigram')) {
      /*
       * A database made by a build with FTS can later be opened by one without it. Remove its
       * triggers so writes keep working, and leave the virtual table for a future capable build
       * to rebuild.
       */
      db.exec(DROP_FTS_TRIGGERS)
      return
    }

    throw error
  }
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
  try {
    return openDatabaseOnce(path)
  } catch (error) {
    /*
     * A torn WAL sidecar pair is the one open failure that heals itself. An ungraceful kill — or
     * anything that deletes the database file but not its `-wal`/`-shm` companions — leaves
     * sidecars SQLite cannot reconcile with the main file, and every reopen fails with an I/O
     * error from then on: the store is bricked until a human deletes two files they have never
     * heard of. The sidecars carry nothing SQLite could still recover in that state, and this
     * file holds debug telemetry whose loss costs nothing, so remove them and try once more.
     * Any second failure — and every non-I/O failure — propagates as the storage error below.
     */
    const cause = error instanceof Error ? error.cause : undefined
    const code =
      cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : undefined

    if (code?.startsWith('SQLITE_IOERR')) {
      rmSync(`${path}-wal`, { force: true })
      rmSync(`${path}-shm`, { force: true })

      return openDatabaseOnce(path)
    }

    throw error
  }
}

function openDatabaseOnce(path: string): DatabaseHandle {
  /*
   * Declared out here so the catch can reach it. Everything after `new Database` — the pragmas
   * and the schema — can throw on a file that exists but is not a database, or is a database an
   * older, incompatible run left behind, and a handle abandoned inside the try keeps its file
   * descriptor and its SQLite lock for the life of the process. The boot that failed is then
   * followed by a retry that cannot succeed either, because the first attempt is still holding
   * the file.
   */
  let db: DatabaseHandle | undefined

  try {
    mkdirSync(dirname(path), { recursive: true })
    const descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600)
    closeSync(descriptor)

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
     * WAL is truncated back to this size at checkpoint instead of being left at its high-water
     * mark. Without a limit a sustained write burst leaves a large `-wal` file — and its resident
     * pages — behind for the rest of the process's life; 4 MiB comfortably covers the batches one
     * checkpoint interval accumulates.
     */
    db.pragma('journal_size_limit = 4194304')

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
    const entryColumns = db.prepare(`pragma table_info(${ENTRIES_TABLE})`).all() as {
      name: string
    }[]
    if (!entryColumns.some((column) => column.name === 'application')) {
      db.exec(
        `alter table ${ENTRIES_TABLE} add column application varchar(191) not null default 'default'`
      )
    }
    const monitoredTagColumns = db.prepare(`pragma table_info(${MONITORED_TAGS_TABLE})`).all() as {
      name: string
      pk: number
    }[]
    const monitoredTagPrimaryKey = monitoredTagColumns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name)
    if (
      !monitoredTagColumns.some((column) => column.name === 'application') ||
      monitoredTagPrimaryKey.join(',') !== 'application,tag'
    ) {
      /*
       * Older local files keyed monitored tags by tag alone. Rebuilding this tiny intent table is
       * the only safe way to change a SQLite primary key, and assigning those rows to `default`
       * preserves exactly what callers of the old unscoped API observed.
       */
      db.exec(`
        begin immediate;
        alter table ${MONITORED_TAGS_TABLE} rename to ${MONITORED_TAGS_TABLE}_legacy;
        create table ${MONITORED_TAGS_TABLE} (
          application varchar(191) not null default 'default',
          tag varchar(${TAG_INDEX_MAX_LENGTH}) not null,
          primary key (application, tag)
        );
        insert or ignore into ${MONITORED_TAGS_TABLE} (application, tag)
          select 'default', tag from ${MONITORED_TAGS_TABLE}_legacy;
        drop table ${MONITORED_TAGS_TABLE}_legacy;
        commit;
      `)
    }
    db.exec(APPLICATION_INDEXES)
    initializeFullTextSearch(db)

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
 * The `sqlite-local` storage driver: a dedicated better-sqlite3 file, usually
 * `tmp/periscope.sqlite`.
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
 *   hop. `save` is nonetheless async-honest: requests arriving in one event-loop turn are
 *   coalesced and committed in one transaction from the check phase. The caller's I/O runs first,
 *   and a busy application pays for one WAL commit per turn rather than one per request. Reads
 *   deliberately do not yield. They serve one dashboard request for one page of at most a
 *   thousand rows, an index scan that costs microseconds, and an extra `setImmediate` per read
 *   would only add a tick of latency to buy nothing.
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
  readonly #ftsAvailable: boolean

  /**
   * Prepared statements by SQL text. See the class note; `Result` is erased on the way in and
   * restored by {@link SqliteLocalStore.#prepare}, which is the one place that knows both.
   */
  readonly #statements = new Map<string, Statement<Binding[]>>()

  /**
   * The mutating operations, each wrapped once in a better-sqlite3 transaction. `db.transaction`
   * returns a function, so the wrappers are built here rather than rebuilt per call.
   */
  readonly #saveAll: (saves: readonly PendingSave[]) => number
  readonly #pruneBefore: (
    before: number,
    perTypeBefore: PruneOptions['perTypeBefore'],
    keepExceptions: boolean,
    application: string | undefined
  ) => number
  readonly #trimTo: (cap: number) => number
  readonly #clearAll: () => void
  readonly #clearApplication: (application: string) => void
  readonly #pendingSaves: PendingSave[] = []
  #saveScheduled = false
  #droppedBatches = 0

  /**
   * In-process entry count, so the per-flush ceiling check in {@link SqliteLocalStore.trim} costs
   * nothing when the store is under the cap. Seeded from `count(*)` at open, advanced by every
   * insert this process commits, and re-read from the file on the maintenance interval — which is
   * also what bounds how long another process's inserts can go unseen.
   */
  #entryCount = 0
  #entryCountDirty = false
  #lastMaintenanceAt = 0

  constructor(options: SqliteLocalStoreOptions) {
    this.#db = openDatabase(options.path)
    this.#ftsAvailable = FTS_ENABLED_DATABASES.has(this.#db)
    this.#saveAll = this.#db.transaction((saves: readonly PendingSave[]) => {
      let inserted = 0
      for (const save of saves) {
        inserted += this.#insertEntries(save.entries)
        this.#insertTags(save.entries)
      }
      return inserted
    })

    this.#pruneBefore = this.#db.transaction(
      (
        before: number,
        perTypeBefore: PruneOptions['perTypeBefore'],
        keepExceptions: boolean,
        application: string | undefined
      ) => {
        this.#prepare(
          `delete from ${FLAGS_TABLE} where expires_at is not null and expires_at <= ?`
        ).run(Date.now())
        const typeCutoffs = Object.entries(perTypeBefore ?? {}).filter(
          (pair): pair is [EntryType, Date] => pair[1] instanceof Date
        )
        const values: Binding[] = []
        let cutoff = 'created_at < ?'

        if (typeCutoffs.length === 0) {
          values.push(before)
        } else {
          cutoff = `created_at < case type ${typeCutoffs.map(() => 'when ? then ?').join(' ')} else ? end`
          for (const [type, date] of typeCutoffs) {
            values.push(type, date.getTime())
          }
          values.push(before)
        }

        const conditions = [cutoff]

        if (keepExceptions) {
          conditions.push('type <> ?')
          values.push(EntryType.EXCEPTION)
        }

        if (application !== undefined) {
          conditions.push('application = ?')
          values.push(application)
        }

        const filter = conditions.join(' and ')

        /*
         * Tag rows go first and explicitly: they are selected through the entries that are about
         * to disappear, so deleting the entries first would leave nothing to select them by. The
         * foreign key would cascade here, but see `openDatabase` for why neither driver leans on
         * that.
         */
        this.#prepare(
          `delete from ${TAGS_TABLE} where entry_uuid in (select uuid from ${ENTRIES_TABLE} where ${filter})`
        ).run(...values)

        return this.#prepare(`delete from ${ENTRIES_TABLE} where ${filter}`).run(...values).changes
      }
    )

    /*
     * The excess is measured *inside* the immediate transaction, under the write lock taken at
     * `begin`. Every process running the application trims on its own flush schedule, so two of
     * them routinely race the same file; an excess measured outside the transaction could be cut
     * twice, leaving `cap - excess` rows behind. Measured under the lock, the second trim counts
     * the survivors of the first and deletes nothing.
     *
     * Deleting the oldest `excess` rows through an ascending `limit` keeps the steady-state cost
     * proportional to the overflow of one flush, instead of the `offset cap` phrasing that walked
     * the newest `cap` index entries on every call.
     */
    this.#trimTo = this.#db.transaction((cap: number) => {
      const total =
        this.#prepare<{ total: number }>(`select count(*) as total from ${ENTRIES_TABLE}`).get()
          ?.total ?? 0
      const excess = total - cap
      if (excess <= 0) return 0

      const doomed = `select uuid from ${ENTRIES_TABLE} order by sequence asc, uuid asc limit ?`

      this.#prepare(`delete from ${TAGS_TABLE} where entry_uuid in (${doomed})`).run(excess)

      return this.#prepare(`delete from ${ENTRIES_TABLE} where uuid in (${doomed})`).run(excess)
        .changes
    }).immediate

    this.#clearAll = this.#db.transaction(() => {
      this.#prepare(`delete from ${TAGS_TABLE}`).run()
      this.#prepare(`delete from ${ENTRIES_TABLE}`).run()
    })
    this.#clearApplication = this.#db.transaction((application: string) => {
      this.#prepare(
        `delete from ${TAGS_TABLE} where entry_uuid in (select uuid from ${ENTRIES_TABLE} where application = ?)`
      ).run(application)
      this.#prepare(`delete from ${ENTRIES_TABLE} where application = ?`).run(application)
    })

    this.#entryCount =
      this.#prepare<{ total: number }>(`select count(*) as total from ${ENTRIES_TABLE}`).get()
        ?.total ?? 0
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
   * `insert or ignore` rather than an upsert: invoking a save again after uncertain storage
   * progress, or replaying a batch whose flush already succeeded, must not fail the rows around
   * the duplicate. Keeping the stored version also keeps the tag rows below consistent with it —
   * an upsert would rewrite the entry while its old tags stayed indexed.
   */
  #insertEntries(entries: StoredEntry[]): number {
    let inserted = 0

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
          row.application,
          row.type,
          row.family_hash,
          row.content as string,
          row.tags as string,
          row.should_display_on_index as number,
          row.sequence,
          Number(row.created_at)
        )
      }

      inserted += this.#prepare(
        `insert or ignore into ${ENTRIES_TABLE} (${ENTRY_COLUMNS}) values ${placeholders(end - offset, ENTRY_COLUMN_COUNT)}`
      ).run(...values).changes
    }

    return inserted
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
   * Commit one pending batch, then relinquish the event loop before taking the next. A flush can
   * contain hundreds of rows; draining the whole backlog in one callback would let telemetry
   * starve the application's own timers and I/O even though each individual SQLite call is fast.
   */
  #drainPendingSaves(): void {
    const save = this.#pendingSaves.shift()
    if (save === undefined) {
      this.#saveScheduled = false
      return
    }

    try {
      this.#entryCount += this.#saveAll([save])
      save.resolve()
    } catch (error) {
      save.reject(error)
    }

    if (this.#pendingSaves.length === 0) {
      this.#saveScheduled = false
    } else {
      setImmediate(() => this.#drainPendingSaves())
    }
  }

  /**
   * Shutdown is the one deliberate exception to the per-batch yield: the provider has already
   * completed its final recorder flush and must not close the handle before accepted saves land.
   */
  #drainPendingSavesSynchronously(): void {
    this.#saveScheduled = false
    const saves = this.#pendingSaves.splice(0)
    if (saves.length === 0) return

    try {
      this.#entryCount += this.#saveAll(saves)
      for (const save of saves) save.resolve()
    } catch (error) {
      for (const save of saves) save.reject(error)
    }
  }

  /**
   * Build the `select` behind {@link SqliteLocalStore.list}: one `where` fragment per filter that
   * was actually set, so an unfiltered query stays an index scan rather than a chain of
   * `1 = 1`s.
   *
   * Tags use a correlated grouped subquery: no join can duplicate entry rows, and the `having`
   * count gives multiple exact tags AND semantics.
   */
  #selectEntries(
    query: EntryQuery,
    cursor: EntryCursor | null
  ): {
    sql: string
    values: Binding[]
  } {
    const conditions: string[] = []
    const values: Binding[] = []

    if (query.type !== undefined) {
      conditions.push('type = ?')
      values.push(query.type)
    }

    const tags = resolveEntryQueryTags(query)
    if (tags.length === 1) {
      conditions.push(
        `exists (select 1 from ${TAGS_TABLE} where ${TAGS_TABLE}.entry_uuid = ${ENTRIES_TABLE}.uuid and ${TAGS_TABLE}.tag = ?)`
      )
      values.push(tags[0])
    } else if (tags.length > 1) {
      conditions.push(
        `exists (select 1 from ${TAGS_TABLE} where ${TAGS_TABLE}.entry_uuid = ${ENTRIES_TABLE}.uuid and ${TAGS_TABLE}.tag in ${placeholders(1, tags.length)} group by ${TAGS_TABLE}.entry_uuid having count(*) = ?)`
      )
      values.push(...tags, tags.length)
    }

    if (query.text !== undefined) {
      // Trigram FTS needs at least three code points; six UTF-16 units always cover three.
      const codePoints = [...query.text.slice(0, 6)].length

      if (this.#ftsAvailable && codePoints >= 3 && !query.text.includes('\0')) {
        const phrase = `"${query.text.replaceAll('"', '""')}"`
        conditions.push(
          `${ENTRIES_TABLE}.rowid in (select rowid from ${ENTRIES_FTS_TABLE} where ${ENTRIES_FTS_TABLE} match ?)`
        )
        values.push(phrase)
      } else {
        conditions.push("lower(content) like ? escape '!'")
        values.push(entryContentLikePattern(query.text))
      }
    }

    const from = parseEntryQueryDate(query.from)
    if (from !== undefined) {
      conditions.push('created_at >= ?')
      values.push(from)
    }

    const to = parseEntryQueryDate(query.to)
    if (to !== undefined) {
      conditions.push('created_at <= ?')
      values.push(to)
    }

    if (query.familyHash !== undefined) {
      conditions.push('family_hash = ?')
      values.push(query.familyHash)
    }

    if (query.batchId !== undefined) {
      conditions.push('batch_id = ?')
      values.push(query.batchId)
    }

    if (query.application !== undefined) {
      conditions.push('application = ?')
      values.push(query.application)
    }

    if (query.displayOnIndex !== undefined) {
      conditions.push('should_display_on_index = ?')
      values.push(query.displayOnIndex ? 1 : 0)
    }

    if (query.level !== undefined) {
      conditions.push(`lower(${jsonFieldText('sqlite', 'content', 'level')}) = ?`)
      values.push(query.level.toLowerCase())
    }

    if (query.afterSequence !== undefined) {
      conditions.push('sequence > ?')
      values.push(encodeSequence(BigInt(query.afterSequence)))
    }

    const direction = query.direction === 'asc' ? 'asc' : 'desc'
    const cursorOperator = direction === 'asc' ? '>' : '<'

    if (cursor !== null) {
      const sequence = encodeSequence(cursor.sequence)
      if (cursor.uuid === null) {
        conditions.push(`sequence ${cursorOperator} ?`)
        values.push(sequence)
      } else {
        conditions.push(
          `(sequence ${cursorOperator} ? or (sequence = ? and uuid ${cursorOperator} ?))`
        )
        values.push(sequence, sequence, cursor.uuid)
      }
    }

    const where = conditions.length === 0 ? '' : ` where ${conditions.join(' and ')}`

    return {
      sql: `select ${ENTRY_COLUMNS} from ${ENTRIES_TABLE}${where} order by sequence ${direction}, uuid ${direction} limit ?`,
      values,
    }
  }

  async save(entries: StoredEntry[]): Promise<void> {
    if (entries.length === 0) return

    return new Promise<void>((resolve, reject) => {
      if (this.#pendingSaves.length >= SAVE_BACKLOG_LIMIT) {
        const dropped = this.#pendingSaves.shift()
        if (dropped !== undefined) {
          this.#droppedBatches += 1
          dropped.reject(
            new Error(
              `Periscope sqlite-local write backlog exceeded ${SAVE_BACKLOG_LIMIT} pending batches`
            )
          )
        }
      }

      this.#pendingSaves.push({ entries, resolve, reject })
      if (this.#saveScheduled) return

      this.#saveScheduled = true
      setImmediate(() => this.#drainPendingSaves())
    })
  }

  async find(uuid: string): Promise<StoredEntry | null> {
    const row = this.#prepare<EntryRow>(
      `select ${ENTRY_COLUMNS} from ${ENTRIES_TABLE} where uuid = ?`
    ).get(uuid)

    return row === undefined ? null : toStoredEntry(row)
  }

  async list(query: EntryQuery = {}): Promise<Paginated<StoredEntry>> {
    const limit = resolvePageSize(query.limit)
    const { sql, values } = this.#selectEntries(query, parseEntryCursor(query.cursor))

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
      nextCursor: overflowed
        ? encodeEntryCursor(data[data.length - 1].sequence, data[data.length - 1].uuid)
        : null,
    }
  }

  async batch(batchId: string): Promise<StoredEntry[]> {
    // Oldest first: the batch screen is a timeline, the opposite of every index screen.
    const rows = this.#prepare<EntryRow>(
      `select ${ENTRY_COLUMNS} from ${ENTRIES_TABLE} where batch_id = ? order by sequence asc, uuid asc`
    ).all(batchId)

    return rows.map(toStoredEntry)
  }

  async counts(application?: string): Promise<EntryTypeCounts> {
    const where = application === undefined ? '' : ' where application = ?'
    const values: Binding[] = application === undefined ? [] : [application]
    const rows = this.#prepare<{ type: EntryType; total: number }>(
      `select type, count(*) as total from ${ENTRIES_TABLE}${where} group by type`
    ).all(...values)

    const counts: EntryTypeCounts = {}

    for (const row of rows) {
      counts[row.type] = row.total
    }

    return counts
  }

  async requestStats(query: RequestStatsQuery): Promise<RequestStatsResult> {
    type RequestStatsRow = {
      createdAt: number | string
      duration: unknown
      status: unknown
      method: unknown
      routePattern: unknown
      url: unknown
    }

    const fromMs = parseEntryQueryDate(query.from) as number
    const conditions = ['type = ?', 'created_at between ? and ?']
    const values: Binding[] = [EntryType.REQUEST, fromMs, parseEntryQueryDate(query.to) as number]

    if (query.application !== undefined) {
      conditions.push('application = ?')
      values.push(query.application)
    }

    const rows = this.#prepare<RequestStatsRow>(
      `select
         created_at as createdAt,
         ${jsonFieldText('sqlite', 'content', 'durationMs')} as duration,
         ${jsonFieldText('sqlite', 'content', 'status')} as status,
         ${jsonFieldText('sqlite', 'content', 'method')} as method,
         ${jsonFieldText('sqlite', 'content', 'routePattern')} as routePattern,
         ${jsonFieldText('sqlite', 'content', 'url')} as url
       from ${ENTRIES_TABLE}
       where ${conditions.join(' and ')}
       order by created_at desc
       limit ?`
    ).all(...values, REQUEST_STATS_MAX_SAMPLES + 1)
    const truncated = rows.length > REQUEST_STATS_MAX_SAMPLES
    const grouped = query.groupBy === 'route'
    const samples = rows
      .slice(0, REQUEST_STATS_MAX_SAMPLES)
      .map((row) => requestStatsSampleFromRow(row, grouped))

    return aggregateRequestStats({
      samples,
      fromMs,
      bucketSeconds: query.bucketSeconds,
      grouped,
      truncated,
    })
  }

  async applications(): Promise<ApplicationSummary[]> {
    const rows = this.#prepare<{
      application: string
      total: number
      latest_at: number | null
    }>(
      `select application, count(*) as total, max(created_at) as latest_at from ${ENTRIES_TABLE} group by application order by latest_at desc, application asc`
    ).all()

    return rows.map((row) => ({
      name: row.application,
      entries: row.total,
      latestAt: row.latest_at === null ? null : new Date(row.latest_at),
    }))
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

    if (query.application !== undefined) {
      conditions.push('application = ?')
      values.push(query.application)
    }

    const limit = resolvePageSize(query.limit)
    const cursor = parseCursor(query.cursor)
    const having = cursor === null ? '' : ' having max(sequence) < ?'
    const groupValues: Binding[] = [
      ...values,
      ...(cursor === null ? [] : [encodeSequence(cursor)]),
      limit + 1,
    ]
    const groups = this.#prepare<{
      family_hash: string
      latest_sequence: string
      total: number
    }>(
      `select family_hash, max(sequence) as latest_sequence, count(*) as total
       from ${ENTRIES_TABLE}
       where ${conditions.join(' and ')}
       group by family_hash${having}
       order by latest_sequence desc
       limit ?`
    ).all(...groupValues)
    const page = groups.slice(0, limit)

    if (page.length === 0) {
      return { data: [], nextCursor: null }
    }

    const sequences = page.map(({ latest_sequence: sequence }) => sequence)
    const rows = this.#prepare<EntryRow>(
      `select ${ENTRY_COLUMNS} from ${ENTRIES_TABLE}
       where ${conditions.join(' and ')}
       and sequence in (${sequences.map(() => '?').join(', ')})`
    ).all(...values, ...sequences)
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
          count: group.total,
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
    const deleted = this.#pruneBefore(
      options.before.getTime(),
      options.perTypeBefore,
      options.keepExceptions === true,
      options.application
    )
    this.#entryCount = Math.max(0, this.#entryCount - deleted)

    return deleted
  }

  async trim(maxEntries: number): Promise<number> {
    const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 0
    const now = Date.now()

    /*
     * `trim` runs after every successful flush, synchronously on the event-loop thread, so its
     * common case must not touch the file at all. The tracked count answers the under-cap check
     * for free; the flag sweep and the count resync — which is also what picks up inserts from
     * other processes sharing the file — run on the maintenance interval instead of per flush.
     */
    if (this.#entryCountDirty || now - this.#lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) {
      this.#lastMaintenanceAt = now
      this.#entryCountDirty = false
      this.#prepare(
        `delete from ${FLAGS_TABLE} where expires_at is not null and expires_at <= ?`
      ).run(now)
      this.#entryCount =
        this.#prepare<{ total: number }>(`select count(*) as total from ${ENTRIES_TABLE}`).get()
          ?.total ?? 0
    }

    if (this.#entryCount <= cap) return 0

    const deleted = this.#trimTo(cap)
    this.#entryCount = Math.max(0, this.#entryCount - deleted)

    return deleted
  }

  async clear(application?: string): Promise<void> {
    if (application === undefined) {
      this.#clearAll()
      this.#entryCount = 0
    } else {
      this.#clearApplication(application)
      this.#entryCountDirty = true
    }
  }

  async monitoredTags(application = 'default'): Promise<string[]> {
    // Ordered so the dashboard's list does not reshuffle itself between two identical requests.
    const rows = this.#prepare<{ tag: string }>(
      `select tag from ${MONITORED_TAGS_TABLE} where application = ? order by tag asc`
    ).all(application)

    return rows.map((row) => row.tag)
  }

  async monitorTag(tag: string, application = 'default'): Promise<void> {
    this.#prepare(
      `insert or ignore into ${MONITORED_TAGS_TABLE} (application, tag) values (?, ?)`
    ).run(application, tag)
  }

  async unmonitorTag(tag: string, application = 'default'): Promise<void> {
    this.#prepare(`delete from ${MONITORED_TAGS_TABLE} where application = ? and tag = ?`).run(
      application,
      tag
    )
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

  async flagsWithPrefix(prefix: string): Promise<StoredFlag[]> {
    const pattern = `${prefix.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`

    return this.#prepare<StoredFlag>(
      `select name, value from ${FLAGS_TABLE}
       where name like ? escape '!' and (expires_at is null or expires_at > ?)`
    ).all(pattern, Date.now())
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

  diagnostics(): StoreDiagnostics {
    return {
      pendingBatches: this.#pendingSaves.length,
      droppedBatches: this.#droppedBatches,
      failedBatches: 0,
      retriedBatches: 0,
    }
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
    this.#drainPendingSavesSynchronously()

    this.#statements.clear()
    this.#db.close()
  }
}
