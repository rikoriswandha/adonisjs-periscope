/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The `database` driver, tested against two real dialects.
 *
 * SQLite always runs. Postgres runs whenever `PERISCOPE_PG_URL` names a reachable server, and CI
 * always provides one — a driver whose whole job is to be dialect-neutral cannot be trusted on
 * the evidence of a single dialect, and every difference that has ever bitten this schema
 * (`bigint` as a string, `count(*)` as a string, `on conflict` spelling, and a JSON column type
 * that refuses escapes ordinary captured payloads contain) is invisible on SQLite.
 *
 * Everything below the shared contract is here because it is a promise this driver makes on its
 * own: that a batch larger than one insert statement survives chunking, that content postgres's
 * JSON parser would refuse still round-trips, that a trim cannot be talked below its own cap by
 * another trim running beside it, that the tag index never outlives the entries it indexes, and
 * that `close()` leaves the application's connection alone.
 */

import { test } from '@japa/runner'

import { DatabaseStore } from '../../src/storage/database_store.ts'
import { ENTRIES_TABLE, FLAGS_TABLE, TAGS_TABLE } from '../../src/storage/sql.ts'
import { EntryType } from '../../src/types.ts'
import { POSTGRES_URL, closeTestDatabases, useTestDatabase } from '../helpers/lucid.ts'
import { makeStoredEntry, runStoreContractTests } from './contract.ts'
import type { TestConnection, TestDatabase } from '../helpers/lucid.ts'
import type { Database } from '@adonisjs/lucid/database'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { RawQueryBindings } from '@adonisjs/lucid/types/querybuilder'

/**
 * Rows seeded before the postgres EXPLAIN check. A planner asked about a table of ten rows picks
 * a sequential scan every time and is right to, so an EXPLAIN against a tiny table proves nothing
 * about the index it was written to prove.
 */
const EXPLAIN_SEED_SIZE = 3_000

/**
 * One row in sixty-four is an exception; the rest cycle through the types a busy application
 * actually produces.
 *
 * The ratio is the whole point of the test. `(type, should_display_on_index, sequence)` earns its
 * keep on a *selective* type: filtering to something that is a tenth of the table lets postgres
 * walk `periscope_entries_sequence_index` backwards, discard non-matches and stop at the limit,
 * and it is right to prefer that — the ordering comes free. It is the exceptions screen, where
 * the matches are a rounding error on the table, that would otherwise scan every row to find a
 * hundred, and that is the plan this test pins.
 */
const EXPLAIN_EXCEPTION_EVERY = 64

/**
 * The types the seed cycles through for every row that is not an exception.
 */
const EXPLAIN_SEED_TYPES = [EntryType.QUERY, EntryType.REQUEST, EntryType.LOG, EntryType.EVENT]

/**
 * One `db:query` event, narrowed to the three fields these tests read.
 */
type QueryEvent = { sql: string; bindings?: RawQueryBindings; inTransaction?: boolean }

/**
 * A store on a freshly created schema. Dropping and recreating rather than truncating: the flags
 * and monitored-tag tables carry state too, and a reset that forgets one of them shows up as a
 * test that passes alone and fails in a suite.
 */
async function createStore(
  connection: TestConnection
): Promise<{ database: TestDatabase; store: DatabaseStore }> {
  const database = await useTestDatabase(connection)
  await database.reset()

  return { database, store: new DatabaseStore({ db: database.db, connection }) }
}

async function countRows(database: TestDatabase, table: string): Promise<number> {
  const [row] = await database.client
    .query<{ total: number | string }>()
    .from(table)
    .count('* as total')

  return Number(row.total)
}

/**
 * Tag rows whose entry no longer exists. The number this must always return is zero: the tag
 * table is an index, and an index that survives its rows makes `list({ tag })` hand the dashboard
 * uuids it cannot resolve.
 */
async function countOrphanTagRows(database: TestDatabase): Promise<number> {
  const [row] = await database.client
    .query<{ total: number | string }>()
    .from(TAGS_TABLE)
    .whereNotIn('entry_uuid', (subquery) => {
      subquery.from(ENTRIES_TABLE).select('uuid')
    })
    .count('* as total')

  return Number(row.total)
}

/**
 * A `Database` whose query client runs `gate` once, immediately before the first transaction it
 * is asked to open, and behaves exactly like the one it wraps in every other respect.
 *
 * `trim` counts rows outside any transaction and then opens one to do the work. The interleaving
 * that used to empty a store is another process finishing its own trim inside that gap, and real
 * concurrency expresses it only sometimes — on SQLite two deferred transactions racing to upgrade
 * to a write surface as `SQLITE_BUSY` rather than as the race under test, which would make the
 * assertion the scheduler's opinion rather than the driver's behaviour. Driving the gap by hand
 * makes the interleaving deterministic and the same on both dialects.
 *
 * Every member other than the two intercepted here is bound to the wrapped object rather than
 * reached through the proxy: Lucid's `Database` and query clients keep `#private` state, and a
 * method invoked with the proxy as its `this` cannot see it.
 */
function gateFirstTransaction(db: Database, gate: () => Promise<void>): Database {
  let pending: (() => Promise<void>) | null = gate

  return new Proxy(db, {
    get(database, property) {
      if (property !== 'connection') {
        const value: unknown = Reflect.get(database, property)

        return typeof value === 'function' ? value.bind(database) : value
      }

      return (name?: string) =>
        new Proxy(database.connection(name), {
          get(client, member) {
            if (member !== 'transaction') {
              const value: unknown = Reflect.get(client, member)

              return typeof value === 'function' ? value.bind(client) : value
            }

            return async (callback: (trx: TransactionClientContract) => Promise<unknown>) => {
              const run = pending
              pending = null

              if (run !== null) {
                await run()
              }

              return client.transaction(callback)
            }
          },
        })
    },
  })
}

runStoreContractTests('database (better-sqlite3)', async () => {
  const { store } = await createStore('sqlite')

  return { store }
})

if (POSTGRES_URL === undefined) {
  /*
   * Registered rather than silently omitted: a suite that reports "63 passed" whether or not it
   * covered postgres is a suite that lets a postgres-only regression through unnoticed.
   */
  test.group('Storage contract (database (postgres))', () => {
    test('cover the storage contract against postgres', () => {}).skip(
      true,
      'Set PERISCOPE_PG_URL=postgres://user:password@host:port/database to run this group.'
    )
  })
} else {
  runStoreContractTests('database (postgres)', async () => {
    const { store } = await createStore('postgres')

    return { store }
  })
}

/**
 * Register the driver-specific tests that make sense on every dialect.
 */
function registerDriverTests(connection: TestConnection): void {
  test.group(`DatabaseStore (${connection})`, () => {
    test('write every entry of a batch larger than one insert statement', async ({ assert }) => {
      const { database, store } = await createStore(connection)

      /*
       * 450 entries is three chunks of `INSERT_CHUNK_SIZE`, and two tags each makes the tag
       * insert chunk as well. The failure this guards against is an off-by-one in the chunk loop
       * that quietly drops the tail — which a batch of 200 or fewer cannot expose.
       */
      const entries = Array.from({ length: 450 }, (_, index) =>
        makeStoredEntry({ tags: ['bulk', `index:${index}`] })
      )

      await store.save(entries)

      assert.equal(await countRows(database, ENTRIES_TABLE), 450)
      assert.equal(await countRows(database, TAGS_TABLE), 900)

      const page = await store.list({ limit: 1_000 })

      assert.lengthOf(page.data, 450)
      assert.isNull(page.nextCursor)
      assert.isNotNull(await store.find(entries[0].uuid))
      assert.isNotNull(await store.find(entries[449].uuid))

      const tagged = await store.list({ tag: 'index:449' })

      assert.deepEqual(
        tagged.data.map((entry) => entry.uuid),
        [entries[449].uuid]
      )
    })

    test('round-trip content that a JSON column type would refuse', async ({ assert }) => {
      const { store } = await createStore(connection)

      /*
       * The two inputs that used to cost a whole batch. A NUL arrives inside captured request
       * bodies, headers and log lines; a lone surrogate is what redaction and truncation leave
       * behind every time they cut a four-byte emoji in half. Both are ordinary JavaScript
       * strings and both survive `JSON.stringify` as escapes, but postgres `jsonb` parses what it
       * is given and answers `unsupported Unicode escape sequence` — rejecting the entire INSERT,
       * so on the `jsonb` columns this driver used to create one unlucky entry silently took
       * every entry flushed alongside it.
       */
      const hostile = makeStoredEntry({
        tags: ['hostile'],
        content: {
          nul: 'before\u0000after',
          loneSurrogate: '\ud83d',
          intactPair: '\ud83d\ude80',
        },
      })
      const innocent = makeStoredEntry({ tags: ['innocent'] })

      await store.save([hostile, innocent])

      const page = await store.list({ tag: 'hostile' })

      assert.lengthOf(page.data, 1)
      assert.deepEqual(page.data[0].content, hostile.content)
      assert.deepEqual(page.data[0].tags, ['hostile'])

      // The other half of the bug: the entries batched with it used to disappear too.
      const innocentPage = await store.list({ tag: 'innocent' })

      assert.lengthOf(innocentPage.data, 1)
    })

    test('delete the tag rows of pruned entries', async ({ assert }) => {
      const { database, store } = await createStore(connection)

      const doomed = makeStoredEntry({
        tags: ['doomed', 'shared'],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      const kept = makeStoredEntry({
        tags: ['kept', 'shared'],
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
      })

      await store.save([doomed, kept])
      assert.equal(await countRows(database, TAGS_TABLE), 4)

      assert.equal(await store.prune({ before: new Date('2026-01-02T00:00:00.000Z') }), 1)

      assert.equal(await countRows(database, TAGS_TABLE), 2)
      assert.equal(await countOrphanTagRows(database), 0)

      const byDoomedTag = await store.list({ tag: 'doomed' })

      assert.lengthOf(byDoomedTag.data, 0)
    })

    test('delete the tag rows of trimmed entries', async ({ assert }) => {
      const { database, store } = await createStore(connection)

      await store.save(Array.from({ length: 5 }, () => makeStoredEntry({ tags: ['trimmed'] })))
      assert.equal(await countRows(database, TAGS_TABLE), 5)

      assert.equal(await store.trim(2), 3)

      assert.equal(await countRows(database, TAGS_TABLE), 2)
      assert.equal(await countOrphanTagRows(database), 0)
    })

    test('hold the cap when a competing trim lands in the same window', async ({ assert }) => {
      const { database, store } = await createStore(connection)

      await store.save(Array.from({ length: 10 }, () => makeStoredEntry({ tags: ['trimmed'] })))

      /*
       * Ten entries and two trims, with the gap between the cheap `count(*)` and the delete
       * belonging to whichever of them arrives second. The competitor keeps eight, so it removes
       * two; a trim that then deleted the six its own count had called excess would leave two
       * rows under a cap of four. Resolving the boundary from the cap, inside the transaction, is
       * what makes the survivors the newest four whatever ran in between.
       */
      let competing = 0
      const gated = new DatabaseStore({
        db: gateFirstTransaction(database.db, async () => {
          competing = await store.trim(8)
        }),
        connection,
      })

      const captured: QueryEvent[] = []
      const record = (event: QueryEvent) => {
        captured.push(event)
      }

      database.client.emitter.on('db:query', record)

      try {
        assert.equal(await gated.trim(4), 4)
      } finally {
        database.client.emitter.off('db:query', record)
      }

      assert.equal(competing, 2)
      assert.equal(await countRows(database, ENTRIES_TABLE), 4)
      assert.equal(await countRows(database, TAGS_TABLE), 4)
      assert.equal(await countOrphanTagRows(database), 0)

      /*
       * Both boundary reads belong inside their own delete's transaction. One resolved in
       * autocommit is one the other trim can invalidate before the delete that trusts it runs,
       * and that is invisible in the row counts of any interleaving that happens to come out
       * right — so the counts above are checked, and then the shape that makes them hold.
       */
      const boundaryReads = captured.filter((event) => /order by .sequence. desc/i.test(event.sql))

      assert.lengthOf(boundaryReads, 2)
      assert.deepEqual(
        boundaryReads.map((event) => event.inTransaction === true),
        [true, true]
      )
    })

    test('empty the tag table on clear', async ({ assert }) => {
      const { database, store } = await createStore(connection)

      await store.save([makeStoredEntry({ tags: ['a', 'b'] }), makeStoredEntry({ tags: ['c'] })])
      await store.monitorTag('a')

      await store.clear()

      assert.equal(await countRows(database, TAGS_TABLE), 0)
      assert.equal(await countRows(database, ENTRIES_TABLE), 0)

      // Monitored tags are user intent and are the one thing `clear` must not touch.
      assert.deepEqual(await store.monitoredTags(), ['a'])
    })

    test('sweep expired flags during trim and prune maintenance', async ({ assert }) => {
      const { database, store } = await createStore(connection)

      await store.setFlag('expired-before-trim', '1', {
        expiresAt: new Date(Date.now() - 1_000),
      })
      await store.setFlag('live', '1', { expiresAt: new Date(Date.now() + 60_000) })
      await store.trim(100)

      await store.setFlag('expired-before-prune', '1', {
        expiresAt: new Date(Date.now() - 1_000),
      })
      await store.prune({ before: new Date(0) })

      assert.equal(await countRows(database, FLAGS_TABLE), 1)
      assert.equal(await store.getFlag('live'), '1')
    })
  })
}

registerDriverTests('sqlite')

test('DatabaseStore bound pending write backlog drops the oldest waiting batch', async ({
  assert,
}) => {
  const { database } = await createStore('sqlite')
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const store = new DatabaseStore({
    db: gateFirstTransaction(database.db, async () => {
      started.resolve()
      await gate.promise
    }),
    connection: 'sqlite',
  })
  const entries = Array.from({ length: 66 }, () => makeStoredEntry())
  const active = store.save([entries[0]])
  await started.promise

  const queued = entries.slice(1).map((entry) =>
    store.save([entry]).then(
      () => 'saved' as const,
      () => 'dropped' as const
    )
  )

  assert.equal(await queued[0], 'dropped')
  gate.resolve()
  await active
  const outcomes = await Promise.all(queued)
  await store.close()

  assert.equal(outcomes.filter((outcome) => outcome === 'dropped').length, 1)
  assert.equal(await countRows(database, ENTRIES_TABLE), 65)
  assert.isNull(await store.find(entries[1].uuid))
  assert.isNotNull(await store.find(entries[65].uuid))
})

if (POSTGRES_URL !== undefined) {
  registerDriverTests('postgres')

  test.group('DatabaseStore (postgres planner)', () => {
    test('serve a selective list query from the type/display index', async ({ assert }) => {
      const { database, store } = await createStore('postgres')

      const entries = Array.from({ length: EXPLAIN_SEED_SIZE }, (_, index) =>
        makeStoredEntry({
          type:
            index % EXPLAIN_EXCEPTION_EVERY === 0
              ? EntryType.EXCEPTION
              : EXPLAIN_SEED_TYPES[index % EXPLAIN_SEED_TYPES.length],
          shouldDisplayOnIndex: index % 8 !== 0,
        })
      )

      await store.save(entries)

      // Without fresh statistics postgres plans against its default guesses and picks a
      // sequential scan whatever the index offers, which would make this test assert nothing.
      await database.client.rawQuery(`analyze ${ENTRIES_TABLE}`)

      /*
       * The SQL is captured from a real `list()` call rather than rebuilt here. A hand-written
       * copy of the query would keep passing after the driver changed its own — the plan would be
       * proved for a query nobody runs.
       */
      const captured: QueryEvent[] = []
      const record = (event: QueryEvent) => {
        captured.push(event)
      }

      database.client.emitter.on('db:query', record)

      try {
        await store.list({ type: EntryType.EXCEPTION, displayOnIndex: true })
      } finally {
        database.client.emitter.off('db:query', record)
      }

      assert.lengthOf(captured, 1)

      const plan = await database.client.rawQuery<{ rows: Record<string, string>[] }>(
        `explain ${captured[0].sql}`,
        captured[0].bindings ?? []
      )
      const planText = plan.rows.map((row) => Object.values(row).join(' ')).join('\n')

      assert.include(planText, 'periscope_entries_type_display_index')
    })
  })
}

/**
 * Last group in the file, so its teardown is the last thing that runs: every pool this spec
 * opened is closed here rather than left for `forceExit` to kill.
 */
test.group('DatabaseStore connections', (group) => {
  group.teardown(async () => {
    await closeTestDatabases()
  })

  test('leave the host connection usable after close', async ({ assert }) => {
    const connections: TestConnection[] =
      POSTGRES_URL === undefined ? ['sqlite'] : ['sqlite', 'postgres']

    for (const connection of connections) {
      const { database, store } = await createStore(connection)

      await store.save([makeStoredEntry()])
      await store.close()

      /*
       * The connection belongs to the application. Draining Periscope writes must not close it:
       * host queries and a second store built on the same connection both remain usable.
       */
      const [row] = await database.client
        .query<{ one: number }>()
        .from(ENTRIES_TABLE)
        .select(database.client.raw('1 as one'))

      assert.equal(Number(row.one), 1)

      const reopened = new DatabaseStore({ db: database.db, connection })

      const reopenedPage = await reopened.list()

      assert.lengthOf(reopenedPage.data, 1)
      await assert.doesNotReject(() => store.close())
    }
  })

  test('wait for an active write before close resolves', async ({ assert }) => {
    const { database } = await createStore('sqlite')
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const store = new DatabaseStore({
      db: gateFirstTransaction(database.db, async () => {
        started.resolve()
        await gate.promise
      }),
      connection: 'sqlite',
    })
    const entry = makeStoredEntry()
    const saving = store.save([entry])
    await started.promise

    let closed = false
    const closing = store.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    assert.isFalse(closed)

    gate.resolve()
    await Promise.all([saving, closing])
    assert.isTrue(closed)
    assert.isNotNull(await store.find(entry.uuid))
  })
})
