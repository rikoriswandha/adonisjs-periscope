/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The recursion gate (plan §0, invariant 2; P3.3's "Done when"), against a real database.
 *
 * This is the one test in the suite where the query watcher and the storage driver are pointed at
 * the *same* Lucid connection on purpose, because that is the only arrangement in which Periscope
 * can record itself. The `database` driver writes entries with SQL, Lucid reports that SQL on
 * `db:query`, and a query watcher that recorded it would hand the recorder new entries to flush —
 * which would emit more SQL, without bound.
 *
 * The playground's own Phase 3 suite cannot prove this: it runs the `sqlite-local` driver, whose
 * writes never touch Lucid at all, so "no Periscope SQL was recorded" holds there for the boring
 * reason that no Periscope SQL exists. Here it holds for the reason that matters.
 *
 * Both defences are exercised: `BatchScope.mute()` around the recorder's own writes, and the
 * watcher's table-level filter for every store access that happens outside a flush.
 */

import { test } from '@japa/runner'

import { defineConfig } from '../../../src/define_config.ts'
import { IncomingEntry } from '../../../src/entry.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { DatabaseStore } from '../../../src/storage/database_store.ts'
import { EntryType } from '../../../src/types.ts'
import { QueryWatcher } from '../../../src/watchers/query/watcher.ts'
import { closeTestDatabases, useTestDatabase } from '../../helpers/lucid.ts'
import { createApp } from '../../helpers/app_factory.ts'

/**
 * Lucid emits `db:query` on the emitter it was constructed with, so the watcher has to subscribe
 * to *that* emitter rather than to the throwaway application's. The application is still needed:
 * `WatcherContext` carries one, and the log watcher's tests aside, nothing else here uses it.
 */
async function setup(options: { connection?: string } = {}) {
  const database = await useTestDatabase('sqlite')
  await database.reset()

  const { app } = await createApp()
  const config = defineConfig({
    storage: {
      driver: 'database',
      ...(options.connection === undefined ? {} : { connection: options.connection }),
    },
  })

  const store = new DatabaseStore({ db: database.db, connection: options.connection })
  const recorder = new Recorder({ config, store })
  const watcher = new QueryWatcher({
    app,
    emitter: database.emitter,
    recorder,
    config,
    dev: true,
  })

  watcher.register()

  return { database, recorder, store, watcher }
}

test.group('QueryWatcher | recursion', (group) => {
  group.teardown(() => closeTestDatabases())

  test('a flush through the database driver records no query entries', async ({ assert }) => {
    const { recorder, store, watcher } = await setup()

    try {
      const context = BatchScope.createContext('request')

      BatchScope.runWith(context, () => {
        recorder.record(IncomingEntry.make(EntryType.REQUEST, { method: 'GET', url: '/ok' }))
      })

      await recorder.flush(context)

      /**
       * The flush wrote one request entry with two statements (entries, then tags). Had either
       * been recorded, this batch would now hold query entries — and the flush that wrote *them*
       * would have written more.
       */
      const stored = await store.list({ limit: 100 })

      assert.lengthOf(stored.data, 1)
      assert.equal(stored.data[0]!.type, EntryType.REQUEST)
      assert.isAbove(watcher.stats.dropped, 0)
      assert.equal(watcher.stats.recorded, 0)
    } finally {
      watcher.cleanup()
    }
  })

  test('store reads outside a flush are dropped by the table filter', async ({ assert }) => {
    const { store, watcher } = await setup()

    try {
      const context = BatchScope.createContext('request')

      /**
       * Deliberately unmuted, which is what a future dashboard controller or prune command would
       * look like if it forgot to mute. The recorder is not involved at all, so `BatchScope.mute`
       * cannot help here — only the watcher's own filter can.
       */
      await BatchScope.runWith(context, async () => {
        await store.list({ type: EntryType.REQUEST })
        await store.counts()
      })

      assert.lengthOf(context.buffer, 0)
      assert.isAbove(watcher.stats.dropped, 0)
    } finally {
      watcher.cleanup()
    }
  })

  test('application queries on the same connection are still recorded', async ({ assert }) => {
    const { database, watcher } = await setup()

    try {
      const context = BatchScope.createContext('request')

      await BatchScope.runWith(context, async () => {
        await database.client.rawQuery('select 1 as one')

        /**
         * `QueryReporter` emits without awaiting, and Emittery dispatches on a later microtask,
         * so the query's own `await` returns before any listener has run. Yielding a macrotask
         * is the difference between asserting on the watcher and asserting on the scheduler.
         */
        await new Promise<void>((resolve) => setImmediate(resolve))
      })

      /**
       * The gate must not be a blanket "ignore this connection". Sharing one connection between
       * the application and Periscope is the `database` driver's entire premise, and a watcher
       * that went quiet in that configuration would be recording nothing while looking healthy.
       */
      assert.lengthOf(context.buffer, 1)
      assert.equal(context.buffer[0]!.type, EntryType.QUERY)
      assert.equal(context.buffer[0]!.content.sql, 'select 1 as one')
      assert.equal(watcher.stats.recorded, 1)
    } finally {
      watcher.cleanup()
    }
  })
})
