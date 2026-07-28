/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from '@japa/runner'
import Database from 'better-sqlite3'
import type { Database as DatabaseHandle } from 'better-sqlite3'

import { PeriscopeStorageError } from '../../src/errors.ts'
import {
  ENTRIES_TABLE,
  FLAGS_TABLE,
  MONITORED_TAGS_TABLE,
  TAGS_TABLE,
} from '../../src/storage/sql.ts'
import { SqliteLocalStore } from '../../src/storage/sqlite_local_store.ts'
import type { StoredEntry } from '../../src/types.ts'
import { makeStoredEntry, runStoreContractTests } from './contract.ts'

/**
 * A database file nobody else can reach, in a directory of its own.
 *
 * The directory is the unit of cleanup rather than the file: SQLite in WAL mode keeps `-wal` and
 * `-shm` siblings next to the database, and a test that removed only the path it was given would
 * leave two files behind every run. Removing the directory takes all three, whatever they are
 * called, and makes "the temp directory is empty afterwards" checkable.
 */
type DatabaseFile = { path: string; remove: () => void }

function createDatabaseFile(): DatabaseFile {
  const directory = mkdtempSync(join(tmpdir(), 'periscope-sqlite-'))

  return {
    path: join(directory, 'periscope.sqlite'),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  }
}

/**
 * A second connection to the same file, for the assertions the store deliberately cannot make.
 *
 * `journal_mode`, `integrity_check` and the tag table's row count are all properties of the
 * *file*, not of the driver's public surface, and exposing the handle so a test could read them
 * would be a worse trade than opening another connection — which is anyway exactly what the
 * dashboard and the prune command do in production.
 */
function openReader(path: string): DatabaseHandle {
  const reader = new Database(path)
  reader.pragma('busy_timeout = 5000')

  return reader
}

/**
 * Rows in the tag index, and rows in it that point at an entry which no longer exists. Every
 * deletion path has to keep the second number at zero: the tag table is a lookup index, and an
 * orphan in it makes `list({ tag })` promise an entry the store can no longer produce.
 */
function tagRowCounts(path: string): { total: number; orphans: number } {
  const reader = openReader(path)

  try {
    const total = reader
      .prepare<[], { total: number }>(`select count(*) as total from ${TAGS_TABLE}`)
      .get()
    const orphans = reader
      .prepare<[], { total: number }>(
        `select count(*) as total from ${TAGS_TABLE}
         where entry_uuid not in (select uuid from ${ENTRIES_TABLE})`
      )
      .get()

    return { total: total?.total ?? -1, orphans: orphans?.total ?? -1 }
  } finally {
    reader.close()
  }
}

/**
 * The other process in the concurrency test: a plain better-sqlite3 writer, deliberately not
 * importing anything of Periscope's, because what is under test is that the *file* survives two
 * unrelated connections writing it — the shape `node ace serve` and `node ace periscope:prune`
 * take in production.
 *
 * It announces itself on stdout once its connection is open so the parent can start writing while
 * it is still going, rather than after it has quietly finished.
 */
const WRITER_PROCESS = `
import Database from 'better-sqlite3'

const db = new Database(process.env.PERISCOPE_TEST_DB)
db.pragma('busy_timeout = 10000')

const insertEntry = db.prepare(
  'insert or ignore into ${ENTRIES_TABLE}' +
    ' (uuid, batch_id, type, family_hash, content, tags,' +
    ' should_display_on_index, sequence, created_at)' +
    ' values (?, ?, ?, ?, ?, ?, ?, ?, ?)'
)
const insertTag = db.prepare(
  'insert or ignore into ${TAGS_TABLE} (entry_uuid, tag) values (?, ?)'
)

const batchId = process.env.PERISCOPE_TEST_BATCH

const write = db.transaction((from, to) => {
  for (let index = from; index < to; index += 1) {
    const uuid = 'child-entry-' + index

    insertEntry.run(
      uuid,
      batchId,
      'log',
      null,
      '{"message":"written by the other process"}',
      '["cross-process"]',
      1,
      '9' + String(index).padStart(19, '0'),
      Date.now()
    )
    insertTag.run(uuid, 'cross-process')
  }
})

process.stdout.write('ready\\n')

/*
 * Spaced out on purpose. Ten transactions back to back would be over before the parent's first
 * save reaches the file, and the test would prove nothing but that two connections can open the
 * same path. A five-millisecond synchronous pause between them keeps this process writing for
 * about fifty milliseconds — long enough for every one of the parent's saves to land in the
 * middle of it, and for the two writers to actually contend for the lock.
 */
const idle = new Int32Array(new SharedArrayBuffer(4))

for (let chunk = 0; chunk < 10; chunk += 1) {
  write(chunk * 10, chunk * 10 + 10)
  Atomics.wait(idle, 0, 0, 5)
}

db.close()
`

/**
 * The other process in the trim test: one trim frozen halfway through, holding the write lock
 * with its deletion already applied and its commit still pending.
 *
 * Every process trims after each successful flush, so two of them enforcing the same cap against
 * one file is the normal case rather than a contrived one. This process plays the first: it
 * deletes the excess it measured, announces itself, and keeps the transaction open long enough
 * for the second trim to observe the contention.
 */
const STALE_TRIMMER_PROCESS = `
import Database from 'better-sqlite3'

const db = new Database(process.env.PERISCOPE_TEST_DB)
db.pragma('busy_timeout = 10000')

const doomed =
  'select uuid from ${ENTRIES_TABLE} order by sequence asc limit ' +
  process.env.PERISCOPE_TEST_EXCESS

const deleteTags = db.prepare('delete from ${TAGS_TABLE} where entry_uuid in (' + doomed + ')')
const deleteEntries = db.prepare('delete from ${ENTRIES_TABLE} where uuid in (' + doomed + ')')

const idle = new Int32Array(new SharedArrayBuffer(4))

db.transaction(() => {
  deleteTags.run()
  deleteEntries.run()

  /*
   * Announced from inside the transaction: the parent starts its own trim here, so its count
   * runs against the snapshot this transaction has not yet replaced and measures the excess this
   * process has already deleted. The pause is what keeps the two overlapping — without it the
   * commit would land first and the second trim would simply find nothing to do.
   */
  process.stdout.write('cut\\n')
  Atomics.wait(idle, 0, 0, 50)
}).immediate()

db.close()
`

runStoreContractTests('sqlite-local', async () => {
  const file = createDatabaseFile()

  return {
    store: new SqliteLocalStore({ path: file.path }),
    cleanup: async () => file.remove(),
  }
})

/**
 * Everything the shared contract cannot own, because it is a promise this driver makes on its
 * own: the file it manages, the pragmas it sets, the second process it has to survive, the
 * chunking its inserts do, and the async boundary better-sqlite3's synchronous API forces it to
 * draw by hand.
 */
test.group('SqliteLocalStore', () => {
  test('recreate the schema after the database file is deleted', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    cleanup(() => file.remove())

    const first = new SqliteLocalStore({ path: file.path })
    const lost = makeStoredEntry()

    await first.save([lost])
    await first.close()

    // The supported reset: no migrations to roll back, no state anywhere but this directory.
    file.remove()

    const second = new SqliteLocalStore({ path: file.path })
    cleanup(() => second.close())

    const fresh = makeStoredEntry()
    await second.save([fresh])

    const found = await second.find(fresh.uuid)

    assert.isNull(await second.find(lost.uuid))
    assert.equal(found?.uuid, fresh.uuid)
  })

  test('create the directory the database file lives in', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    cleanup(() => file.remove())

    const nested = join(file.path, '..', 'nested', 'deeper', 'periscope.sqlite')
    const store = new SqliteLocalStore({ path: nested })
    cleanup(() => store.close())

    const entry = makeStoredEntry()
    await store.save([entry])

    const found = await store.find(entry.uuid)

    assert.equal(found?.uuid, entry.uuid)
  })

  test('create a new database file with owner-only permissions', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    cleanup(async () => {
      await store.close()
      file.remove()
    })

    if (process.platform !== 'win32') {
      assert.equal(statSync(file.path).mode & 0o777, 0o600)
    }
  })

  test('keep the database in WAL mode', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    cleanup(async () => {
      await store.close()
      file.remove()
    })

    await store.save([makeStoredEntry()])

    const reader = openReader(file.path)

    try {
      // WAL is written into the file header, so a connection that never asked for it still gets
      // it — which is what makes the dashboard and the prune command inherit the setting.
      assert.equal(reader.pragma('journal_mode', { simple: true }), 'wal')
    } finally {
      reader.close()
    }
  })

  test('throw a storage error when the database cannot be opened', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    cleanup(() => file.remove())

    /*
     * A regular file standing where the store wants a directory. Whatever the platform's errno
     * spelling, this is the boot-time failure the constructor has to report rather than swallow:
     * recording that silently goes nowhere is worse than a process that will not start.
     */
    const blocker = new SqliteLocalStore({ path: file.path })
    await blocker.close()

    const blocked = join(file.path, 'periscope.sqlite')

    let failure: unknown

    try {
      await new SqliteLocalStore({ path: blocked }).close()
    } catch (error) {
      failure = error
    }

    /*
     * The wording is the feature here, as it is in `resolve.ts`. A boot failure that names only
     * the errno leaves the reader with nothing to do about it, so the message has to carry both
     * ways out: make the directory work, or stop asking Periscope for a file at all. The
     * directory rather than `tmp/`, because nothing here knows the provider chose the path.
     */
    assert.instanceOf(failure, PeriscopeStorageError)
    assert.include((failure as Error).message, blocked, 'the error must name the path')
    assert.include(
      (failure as Error).message,
      `"${dirname(blocked)}" exists`,
      'the error must name the directory to fix'
    )
    assert.include((failure as Error).message, 'storage.driver')
    assert.include((failure as Error).message, 'memory')
    assert.include((failure as Error).message, 'config/periscope.ts')
  })

  test('write a batch far larger than the insert chunk size', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    cleanup(async () => {
      await store.close()
      file.remove()
    })

    // Two full chunks and a partial one, so both placeholder shapes the insert can take are
    // exercised by a single save.
    const entries = Array.from({ length: 450 }, () => makeStoredEntry({ tags: ['bulk'] }))

    await store.save(entries)

    const page = await store.list({ limit: 1_000 })
    const tagged = await store.list({ tag: 'bulk', limit: 1_000 })

    assert.lengthOf(page.data, 450)
    assert.isNull(page.nextCursor)
    assert.lengthOf(tagged.data, 450)

    const first = await store.find(entries[0].uuid)
    const last = await store.find(entries[449].uuid)

    assert.equal(first?.uuid, entries[0].uuid)
    assert.equal(last?.uuid, entries[449].uuid)
  })

  test('delete the tag rows of pruned entries', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    cleanup(async () => {
      await store.close()
      file.remove()
    })

    await store.save([
      makeStoredEntry({ tags: ['old', 'doomed'], createdAt: new Date('2026-01-01T00:00:00Z') }),
      makeStoredEntry({ tags: ['fresh'], createdAt: new Date('2026-03-01T00:00:00Z') }),
    ])

    assert.equal(await store.prune({ before: new Date('2026-02-01T00:00:00Z') }), 1)
    assert.deepEqual(tagRowCounts(file.path), { total: 1, orphans: 0 })
  })

  test('delete the tag rows of trimmed entries', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    cleanup(async () => {
      await store.close()
      file.remove()
    })

    await store.save(Array.from({ length: 5 }, () => makeStoredEntry({ tags: ['a', 'b'] })))

    assert.equal(await store.trim(2), 3)
    assert.deepEqual(tagRowCounts(file.path), { total: 4, orphans: 0 })
  })

  test('sweep expired flags during trim and prune maintenance', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    cleanup(async () => {
      await store.close()
      file.remove()
    })

    await store.setFlag('expired-before-trim', '1', {
      expiresAt: new Date(Date.now() - 1_000),
    })
    await store.setFlag('live', '1', { expiresAt: new Date(Date.now() + 60_000) })
    await store.trim(100)

    await store.setFlag('expired-before-prune', '1', {
      expiresAt: new Date(Date.now() - 1_000),
    })
    await store.prune({ before: new Date(0) })

    const reader = openReader(file.path)
    try {
      const rows = reader.prepare<[], { name: string }>(`select name from ${FLAGS_TABLE}`).all()
      assert.deepEqual(
        rows.map(({ name }) => name),
        ['live']
      )
    } finally {
      reader.close()
    }
  })

  test('delete every tag row on clear', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    cleanup(async () => {
      await store.close()
      file.remove()
    })

    await store.save(Array.from({ length: 3 }, () => makeStoredEntry({ tags: ['a', 'b'] })))
    await store.clear()

    assert.deepEqual(tagRowCounts(file.path), { total: 0, orphans: 0 })
  })

  test('yield to the event loop before writing a batch', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    const reader = openReader(file.path)
    cleanup(async () => {
      reader.close()
      await store.close()
      file.remove()
    })

    const total = reader.prepare<[], { total: number }>(
      `select count(*) as total from ${ENTRIES_TABLE}`
    )

    const saving = store.save([makeStoredEntry()])

    /*
     * This assertion runs in the caller's *synchronous* continuation, before any microtask or
     * timer. better-sqlite3 is synchronous, so a `save` that started writing immediately would
     * already have committed by now and this second connection would see the row.
     */
    assert.equal(total.get()?.total, 0, 'the write ran inline with the caller')

    /*
     * And still nothing after the microtask queue has been drained several times over. A `save`
     * that only awaited an already-resolved promise would pass the assertion above while still
     * running a multi-row write ahead of every pending I/O callback; the driver owes the event
     * loop a real turn, which is what `setImmediate` buys.
     */
    for (let tick = 0; tick < 10; tick += 1) {
      await Promise.resolve()
    }

    assert.equal(total.get()?.total, 0, 'the write ran on the microtask queue')

    await saving

    assert.equal(total.get()?.total, 1)
  })

  test('drain a scheduled save before closing the database handle', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    cleanup(() => file.remove())
    const saving = store.save([makeStoredEntry()])

    await store.close()
    await saving

    const reader = openReader(file.path)
    try {
      const row = reader
        .prepare<[], { total: number }>(`select count(*) as total from ${ENTRIES_TABLE}`)
        .get()
      assert.equal(row?.total, 1)
    } finally {
      reader.close()
    }
  })

  test('survive a second process writing the same file', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    cleanup(async () => {
      await store.close()
      file.remove()
    })

    const childBatch = randomUUID()
    const parentBatch = randomUUID()

    const child = spawn(process.execPath, ['--input-type=module', '-e', WRITER_PROCESS], {
      // The package root, so the child's bare `better-sqlite3` import resolves to the same
      // installed driver this process is using.
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, PERISCOPE_TEST_DB: file.path, PERISCOPE_TEST_BATCH: childBatch },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })

    // Wait for the child's connection to be open, so the two are writing the same file at the
    // same time rather than one after the other.
    await new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding('utf8')
      child.stdout.once('data', () => resolve())
      child.once('error', reject)
      child.once('exit', () => resolve())
    })

    const parentEntries: StoredEntry[] = []

    for (let round = 0; round < 10; round += 1) {
      const chunk = Array.from({ length: 10 }, () =>
        makeStoredEntry({ batchId: parentBatch, tags: ['in-process'] })
      )

      parentEntries.push(...chunk)
      await store.save(chunk)
    }

    assert.equal(await exited, 0, `the writer process failed: ${stderr}`)

    // Both processes' work is readable through the store, and neither lost the other's rows.
    assert.lengthOf(await store.batch(childBatch), 100)
    assert.lengthOf(await store.batch(parentBatch), parentEntries.length)

    const tagged = await store.list({ tag: 'cross-process', limit: 1_000 })

    assert.lengthOf(tagged.data, 100)
    assert.deepEqual(tagRowCounts(file.path), { total: 200, orphans: 0 })

    const reader = openReader(file.path)

    try {
      assert.equal(reader.pragma('integrity_check', { simple: true }), 'ok')
    } finally {
      reader.close()
    }
  }).timeout(30_000)

  test('keep the store at the cap when another process trims the same file', async ({
    assert,
    cleanup,
  }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    cleanup(async () => {
      await store.close()
      file.remove()
    })

    const cap = 50
    const entries = Array.from({ length: 100 }, () => makeStoredEntry({ tags: ['trimmed'] }))

    await store.save(entries)

    const child = spawn(process.execPath, ['--input-type=module', '-e', STALE_TRIMMER_PROCESS], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        PERISCOPE_TEST_DB: file.path,
        PERISCOPE_TEST_EXCESS: String(entries.length - cap),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })

    // Wait for the other trim to be mid-flight: lock held, rows deleted, commit pending.
    await new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding('utf8')
      child.stdout.once('data', () => resolve())
      child.once('error', reject)
      child.once('exit', () => resolve())
    })

    /*
     * Counts a hundred entries — the other transaction is invisible until it commits — and then
     * blocks on its write lock. By the time this trim runs, the fifty rows it counted as excess
     * are already gone, and a deletion that trusted that number would take fifty more and leave
     * the store empty.
     */
    const trimmed = await store.trim(cap)

    assert.equal(await exited, 0, `the trimming process failed: ${stderr}`)
    assert.equal(trimmed, 0, 'the trim reported rows the other process had already deleted')

    const page = await store.list({ limit: 1_000 })

    assert.lengthOf(page.data, cap, 'two concurrent trims took the store below its cap')

    // And took exactly the entries the cap asked for: the survivors are the newest `cap` of
    // them, handed back newest first.
    const survivors = entries.slice(cap).map((entry) => entry.uuid)
    const listed = page.data.map((entry) => entry.uuid)

    assert.deepEqual(listed, survivors.reverse())
    assert.deepEqual(tagRowCounts(file.path), { total: cap, orphans: 0 })
  }).timeout(30_000)

  test('close the connection when the schema cannot be created', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    cleanup(() => file.remove())

    /*
     * A table standing where one of the schema's indexes wants its name. `create index if not
     * exists` does not forgive that, which makes this the failure the constructor is most likely
     * to hit on a file left by an older or foreign run: one that happens *after* the connection
     * is open, rather than in `new Database`.
     */
    const seed = new Database(file.path)
    seed.exec('create table periscope_entries_sequence_index (x)')
    seed.close()

    assert.throws(() => new SqliteLocalStore({ path: file.path }), PeriscopeStorageError)

    /*
     * SQLite removes the `-wal` and `-shm` siblings when the last connection to a file closes, so
     * their absence is the one observable proof that the failed open did not walk away holding
     * the descriptor and its lock — which it would then hold for the life of the process, making
     * the retry that follows a boot failure fail too.
     */
    assert.deepEqual(
      readdirSync(dirname(file.path)).sort(),
      ['periscope.sqlite'],
      'the failed open left its connection behind'
    )
  })

  test('declare every primary-key column not null', async ({ assert, cleanup }) => {
    const file = createDatabaseFile()
    const store = new SqliteLocalStore({ path: file.path })
    cleanup(async () => {
      await store.close()
      file.remove()
    })

    /**
     * The `pragma table_info` columns this check reads. better-sqlite3 types `pragma` as
     * `unknown`, having no way to know which pragma was asked for.
     */
    type ColumnInfo = { name: string; notnull: 0 | 1; pk: number }

    const reader = openReader(file.path)
    const nullable: string[] = []

    try {
      /*
       * SQLite enforces `not null` on an `integer primary key` and on nothing else: every other
       * primary key accepts NULL unless the column says so itself. `database_schema.ts` declares
       * all four of these `notNullable()`, so a nullable one here is the two schemas that back
       * the same store disagreeing about what a row may hold.
       */
      for (const table of [ENTRIES_TABLE, TAGS_TABLE, MONITORED_TAGS_TABLE, FLAGS_TABLE]) {
        for (const column of reader.pragma(`table_info(${table})`) as ColumnInfo[]) {
          if (column.pk > 0 && column.notnull === 0) {
            nullable.push(`${table}.${column.name}`)
          }
        }
      }
    } finally {
      reader.close()
    }

    assert.deepEqual(nullable, [])
  })
})
