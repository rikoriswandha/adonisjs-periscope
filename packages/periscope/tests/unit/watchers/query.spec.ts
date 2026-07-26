/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import type { DbQueryEventNode } from '@adonisjs/lucid/types/database'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import { familyHash } from '../../../src/watchers/hash.ts'
import { normaliseSql } from '../../../src/watchers/query/normalise_sql.ts'
import { QueryWatcher } from '../../../src/watchers/query/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

/**
 * The runtime payload adds `error` after Lucid has assembled its declared query data. Keeping the
 * widening in this test mirrors the production watcher's documented boundary and lets the
 * fixture match the real reporter instead of pretending failed queries are impossible.
 */
type RuntimeQueryEvent = DbQueryEventNode & { error?: Error }

/**
 * `db:query` only appears on the framework's typed event map once Lucid's *provider* types are
 * loaded, and this package compiles without them on purpose — Lucid is an optional peer. The
 * suite emits through the same narrow structural view the watcher subscribes through, so the
 * fixture and the production code agree on the one contract that matters.
 */
type QueryEventSink = {
  emit(event: 'db:query', data: RuntimeQueryEvent): Promise<void>
}

type WatcherOptions = {
  slowMs?: number
  hideBindings?: boolean
  dev?: boolean
  storage?:
    | { driver: 'memory'; maxEntries?: number }
    | { driver: 'database'; connection: string; maxEntries?: number }
}

function queryEvent(overrides: Partial<RuntimeQueryEvent> = {}): RuntimeQueryEvent {
  return {
    connection: 'primary',
    method: 'select',
    sql: 'select * from users where id = ?',
    bindings: [1],
    duration: [0, 12_000_000],
    inTransaction: false,
    ...overrides,
  }
}

async function makeWatcher(options: WatcherOptions = {}) {
  const { app, emitter } = await createApp()
  const config = defineConfig({
    storage: options.storage ?? { driver: 'memory' },
    watchers: {
      query: {
        slowMs: options.slowMs,
        hideBindings: options.hideBindings,
      },
    },
  })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const watcher = new QueryWatcher({ app, emitter, recorder, config, dev: options.dev ?? true })

  watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())

  return { emitter: emitter as unknown as QueryEventSink, watcher }
}

test.group('QueryWatcher', () => {
  test('record a query inside the active request batch with searchable content', async ({
    assert,
  }) => {
    const { emitter, watcher } = await makeWatcher({ slowMs: 20 })

    await BatchScope.run('request', async () => {
      const context = BatchScope.current()
      if (context === undefined) {
        throw new Error('Expected BatchScope.run to install a request context')
      }

      await emitter.emit(
        'db:query',
        queryEvent({
          connection: 'primary',
          model: 'User',
          method: 'first',
          sql: 'select * from users where id = ?',
          bindings: [7],
          duration: [0, 12_500_000],
          inTransaction: true,
        })
      )

      assert.lengthOf(context.buffer, 1)
      const entry = context.buffer[0]
      assert.equal(entry.batchId, context.batchId)
      assert.equal(entry.type, EntryType.QUERY)
      assert.deepEqual(entry.content, {
        sql: 'select * from users where id = ?',
        bindings: [7],
        connection: 'primary',
        method: 'first',
        model: 'User',
        durationMs: 12.5,
        inTransaction: true,
      })
      assert.deepEqual(entry.tags, ['connection:primary', 'method:first', 'model:User'])
      assert.isTrue(entry.displayOnIndex)
      assert.equal(entry.familyHash, familyHash(normaliseSql(entry.content.sql as string)))
    })

    assert.deepEqual(watcher.stats, { recorded: 1, dropped: 0 })
  })

  test('apply the slow boundary, elide bindings, and tolerate a missing duration', async ({
    assert,
  }) => {
    const { emitter, watcher } = await makeWatcher({ slowMs: 25, hideBindings: true })
    const context = BatchScope.createContext('request')

    await BatchScope.runWith(context, async () => {
      await emitter.emit(
        'db:query',
        queryEvent({ bindings: ['private', 'values'], duration: [0, 25_000_000] })
      )
      await emitter.emit('db:query', queryEvent({ bindings: ['private'], duration: undefined }))
    })

    assert.lengthOf(context.buffer, 2)
    assert.equal(context.buffer[0].content.durationMs, 25)
    assert.deepEqual(context.buffer[0].content.bindings, { count: 2 })
    assert.include(context.buffer[0].tags, 'slow')
    assert.notProperty(context.buffer[1].content, 'durationMs')
    assert.deepEqual(context.buffer[1].content.bindings, { count: 1 })
    assert.notInclude(context.buffer[1].tags, 'slow')
    assert.deepEqual(watcher.stats, { recorded: 2, dropped: 0 })
  })

  test('drop Periscope storage traffic and keep host traffic on the same connection', async ({
    assert,
  }) => {
    const { emitter, watcher } = await makeWatcher({
      storage: { driver: 'database', connection: 'primary' },
    })
    const context = BatchScope.createContext('request')

    await BatchScope.runWith(context, async () => {
      await emitter.emit(
        'db:query',
        queryEvent({
          connection: 'primary',
          method: 'insert',
          sql: 'insert into "periscope_entries" ("uuid", "batch_id") values (?, ?)',
        })
      )

      /**
       * Same connection, application query. The gate keys off the tables a statement names, not
       * off the connection it ran on, precisely so that sharing one connection — which is the
       * whole premise of the `database` driver — does not silently mute the watcher.
       */
      await emitter.emit('db:query', queryEvent({ connection: 'primary' }))
    })

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].content.sql, 'select * from users where id = ?')
    assert.deepEqual(watcher.stats, { recorded: 1, dropped: 1 })
  })

  test('never gate on tables when the driver is not the shared database', async ({ assert }) => {
    const { emitter, watcher } = await makeWatcher({ storage: { driver: 'memory' } })
    const context = BatchScope.createContext('request')

    /**
     * `sqlite-local` and `memory` never touch the application's Lucid connection, so a statement
     * naming a Periscope table under those drivers is the application's own — a maintenance
     * script, a fixture, a migration — and hiding it would be Periscope editing the record.
     */
    await BatchScope.runWith(context, () =>
      emitter.emit('db:query', queryEvent({ sql: 'select count(*) from "periscope_entries"' }))
    )

    assert.lengthOf(context.buffer, 1)
    assert.deepEqual(watcher.stats, { recorded: 1, dropped: 0 })
  })

  test('normalise dialect literals, quoted identifiers, placeholders, and comments', ({
    assert,
  }) => {
    const cases: {
      name: string
      sql: string
      expected: string
      equivalentSql?: string
    }[] = [
      {
        name: 'line and block comments',
        sql: "SELECT/* request-id: 'abc' */* FROM users -- don't alter SQL\nWHERE id = 1",
        expected: 'select * from users where id = ?',
        equivalentSql:
          "select /* request-id: 'xyz' */ * FROM users -- don't alter SQL\nwhere id = 932",
      },
      {
        name: 'unterminated line comment',
        sql: "SELECT * FROM users WHERE id = 1 -- don't scan this",
        expected: 'select * from users where id = ?',
      },
      {
        name: 'unterminated block comment',
        sql: "SELECT * FROM users WHERE id = 1 /* don't scan this",
        expected: 'select * from users where id = ?',
      },
      {
        name: 'escaped single quotes',
        sql: "SELECT 'it''s fine', id FROM users WHERE name = 'O''Brien'",
        expected: 'select ?, id from users where name = ?',
        equivalentSql: "select 'that''s different', id from users where name = 'D''Angelo'",
      },
      {
        name: 'double-quoted identifiers',
        sql: `SELECT "WHERE", "author's note" FROM "Order"`,
        expected: `select "WHERE", "author's note" from "Order"`,
      },
      {
        name: 'backtick-quoted identifiers',
        sql: "SELECT `WHERE`, `author's note` FROM `Order`",
        expected: "select `WHERE`, `author's note` from `Order`",
      },
      {
        name: 'PostgreSQL positional placeholders',
        sql: 'SELECT * FROM users WHERE id = $1 AND role_id = $2',
        expected: 'select * from users where id = $1 and role_id = $2',
      },
      {
        name: 'tagged dollar-quoted strings',
        sql: "SELECT $body$WHERE id = 99 -- not a comment\nAND note = 'x'$body$ FROM users",
        expected: 'select ? from users',
        equivalentSql: 'select $body$a completely different body$body$ FROM users',
      },
      {
        name: 'untagged dollar-quoted strings',
        sql: 'SELECT $$WHERE id = 99$$ FROM users',
        expected: 'select ? from users',
      },
      {
        name: 'hexadecimal and scientific-notation numbers',
        sql: 'SELECT * FROM metrics WHERE mask = 0xFF AND value = 6.02e23',
        expected: 'select * from metrics where mask = ? and value = ?',
        equivalentSql: 'select * FROM metrics WHERE mask = 0x0A AND value = 1e-9',
      },
      {
        name: 'two-value binding list',
        sql: 'SELECT * FROM users WHERE id IN (?, ?)',
        expected: 'select * from users where id in (?, ?)',
      },
      {
        name: 'three-value binding list',
        sql: 'SELECT * FROM users WHERE id IN (?, ?, ?)',
        expected: 'select * from users where id in (?, ?, ?)',
      },
    ]

    for (const { name, sql, expected, equivalentSql } of cases) {
      const shape = normaliseSql(sql)
      assert.equal(shape, expected, name)

      if (equivalentSql !== undefined) {
        assert.equal(normaliseSql(equivalentSql), shape, `${name} should group equivalent values`)
      }
    }
  })

  test('retain SQL after comments when distinguishing query families', ({ assert }) => {
    const byId = normaliseSql("select * from users -- don't alter SQL\nwhere id = 1")
    const byAccount = normaliseSql("select * from users -- don't alter SQL\nwhere account_id = 1")

    assert.notEqual(byId, byAccount)
    assert.notEqual(familyHash(byId), familyHash(byAccount))
  })

  test('retain binding-list cardinality in the current query shape', ({ assert }) => {
    const twoBindings = normaliseSql('select * from users where id in (?, ?)')
    const threeBindings = normaliseSql('select * from users where id in (?, ?, ?)')

    /**
     * Punctuation remains structural in this deliberately small lexical pass. This assertion
     * documents the verified limitation instead of implying that different binding-list lengths
     * already collapse to one family.
     */
    assert.notEqual(twoBindings, threeBindings)
    assert.notEqual(familyHash(twoBindings), familyHash(threeBindings))
  })

  test('group equal SQL shapes and keep different shapes apart', async ({ assert }) => {
    const { emitter } = await makeWatcher()
    const context = BatchScope.createContext('request')
    const firstSql = "SELECT * FROM users WHERE id = 1 AND email = 'one@example.com'"
    const secondSql = "select * FROM users WHERE id = 892 AND email = 'two@example.com'"
    const differentSql = "SELECT * FROM users WHERE account_id = 892 AND email = 'two@example.com'"

    const firstShape = normaliseSql(firstSql)
    const secondShape = normaliseSql(secondSql)
    const differentShape = normaliseSql(differentSql)

    assert.equal(firstShape, 'select * from users where id = ? and email = ?')
    assert.equal(firstShape, secondShape)
    assert.notEqual(firstShape, differentShape)
    assert.equal(familyHash(firstShape), familyHash(secondShape))
    assert.notEqual(familyHash(firstShape), familyHash(differentShape))

    await BatchScope.runWith(context, async () => {
      await emitter.emit('db:query', queryEvent({ sql: firstSql }))
      await emitter.emit('db:query', queryEvent({ sql: secondSql }))
      await emitter.emit('db:query', queryEvent({ sql: differentSql }))
    })

    assert.lengthOf(context.buffer, 3)
    assert.equal(context.buffer[0].familyHash, context.buffer[1].familyHash)
    assert.notEqual(context.buffer[0].familyHash, context.buffer[2].familyHash)
  })

  test('safe-serialise cyclic bindings and retain only error name and message', async ({
    assert,
  }) => {
    const { emitter } = await makeWatcher()
    const context = BatchScope.createContext('request')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const error = Object.assign(new Error('connection lost'), {
      bindings: ['do not copy'],
      driverCode: 'ECONNRESET',
    })

    await BatchScope.runWith(context, () =>
      emitter.emit(
        'db:query',
        queryEvent({
          bindings: [cyclic, Buffer.from('abc'), new Date('2026-01-02T03:04:05Z')],
          error,
        })
      )
    )

    assert.deepEqual(context.buffer[0].content.bindings, [
      { self: '[Circular]' },
      '[Buffer 3 bytes]',
      '2026-01-02T03:04:05.000Z',
    ])
    assert.deepEqual(context.buffer[0].content.error, {
      name: 'Error',
      message: 'connection lost',
    })
    assert.notProperty(context.buffer[0].content.error as object, 'bindings')
    assert.notProperty(context.buffer[0].content.error as object, 'driverCode')
  })

  test('record no call site, because none is reachable from the event', async ({ assert }) => {
    const { emitter } = await makeWatcher()
    const context = BatchScope.createContext('request')

    await BatchScope.runWith(context, () => emitter.emit('db:query', queryEvent()))

    /**
     * Pinned deliberately. `QueryReporter` emits after the query settles and Emittery dispatches
     * a microtask later, so no application frame survives to record — see the watcher's own doc
     * block. Should a future Lucid grow a build-time reporter hook, this assertion is the one
     * that has to be rewritten, and rewriting it is the moment to re-add the config switch.
     */
    assert.notProperty(context.buffer[0].content, 'location')
  })

  test('unsubscribe idempotently during cleanup', async ({ assert }) => {
    const { emitter, watcher } = await makeWatcher()
    const context = BatchScope.createContext('request')

    assert.doesNotThrow(() => {
      watcher.cleanup()
      watcher.cleanup()
    })
    await BatchScope.runWith(context, () => emitter.emit('db:query', queryEvent()))

    assert.lengthOf(context.buffer, 0)
  })
})
