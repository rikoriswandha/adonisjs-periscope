import { existsSync } from 'node:fs'
import { test } from '@japa/runner'
import { setTimeout as sleep } from 'node:timers/promises'
import app from '@adonisjs/core/services/app'
import recorder from 'periscope/services/recorder'
import { BatchScope, EntryType, IncomingEntry, SqliteLocalStore } from 'periscope'

/**
 * The demo (`node ace periscope:demo`) as an assertion, so CI catches a regression in the wiring
 * rather than a human noticing that the demo prints something odd.
 *
 * This is the only test that exercises Periscope through the *published* surface — the package's
 * subpath exports, the provider, `config/periscope.ts` and the container — instead of importing
 * `src/` directly the way the package's own unit tests do. It therefore fails on things the unit
 * suite structurally cannot see: a broken `exports` map, a provider that never binds the recorder,
 * a config file the provider rejects.
 */
test.group('periscope recorder (playground wiring)', (group) => {
  /**
   * The playground records into `tmp/periscope.sqlite`, which outlives the process. Without this
   * the suite would pass on a clean checkout and fail on the second run, as yesterday's entries
   * turned every "exactly one entry of this type" assertion into a lie. `clear()` empties entries
   * only — monitored tags and flags are user intent and survive it, which is exactly right here.
   */
  group.each.setup(async () => {
    await recorder.store.clear()
  })

  test('the provider binds a recorder backed by the configured store', ({ assert }) => {
    assert.isTrue(recorder.enabled)

    /**
     * `config/periscope.ts` names the `sqlite-local` driver, so this is the assertion that the
     * provider read the config and built what it asked for. It is only meaningful next to the
     * `enabled` assertion above: a *disabled* Periscope is handed a `MemoryStore` instead,
     * deliberately, so that switching Periscope off never constructs the configured driver.
     * Enabled plus `SqliteLocalStore` is the pair that proves this store came out of
     * `createStore(config, context)`.
     */
    assert.instanceOf(recorder.store, SqliteLocalStore)

    /**
     * And it is rooted where the docs, the demo command and `rm tmp/periscope.sqlite` all say it
     * is. `app.tmpPath()` is the only place a fixture app may write.
     */
    assert.isTrue(existsSync(app.tmpPath('periscope.sqlite')))
  })

  test('entries recorded across async boundaries flush into one batch', async ({ assert }) => {
    const context = BatchScope.createContext('command')

    await BatchScope.runWith(context, async () => {
      recorder.record(
        IncomingEntry.make(EntryType.REQUEST, {
          method: 'POST',
          url: '/demo/login',
          payload: { email: 'demo@periscope.test', password: 'hunter2' },
        }).withTags('status:200')
      )

      await Promise.resolve()

      recorder.record(
        IncomingEntry.make(EntryType.QUERY, {
          sql: 'select * from "users" where "email" = ?',
          duration: 3.2,
        }).withFamilyHash('demo-family-hash')
      )

      await sleep(1)

      recorder.record(IncomingEntry.make(EntryType.LOG, { level: 'warn', message: 'demo' }))
    })

    await recorder.flush(context)

    const entries = await recorder.store.batch(context.batchId)

    assert.deepEqual(
      entries.map((entry) => entry.type),
      [EntryType.REQUEST, EntryType.QUERY, EntryType.LOG]
    )
    assert.isTrue(entries.every((entry) => entry.batchId === context.batchId))

    /**
     * `batch()` is timeline order, so the sequences must be strictly ascending — the property the
     * batch-detail screen renders against in Phase 4.
     */
    const sequences = entries.map((entry) => entry.sequence)
    assert.deepEqual(
      [...sequences].sort((a, b) => (a < b ? -1 : 1)),
      sequences
    )

    const request = entries[0]
    assert.deepEqual(request.content.payload, {
      email: 'demo@periscope.test',
      password: '[REDACTED]',
    })
    assert.deepEqual(request.tags, ['status:200'])
    assert.isTrue(request.shouldDisplayOnIndex)
    assert.equal(entries[1].familyHash, 'demo-family-hash')
  })

  test('the flushed batch is queryable through the store contract', async ({ assert }) => {
    const context = BatchScope.createContext('command')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.EVENT, { name: 'demo:queried' }))
    })

    await recorder.flush(context)

    const page = await recorder.store.list({ batchId: context.batchId, type: EntryType.EVENT })

    assert.lengthOf(page.data, 1)
    assert.isNull(page.nextCursor)
    assert.equal(page.data[0].content.name, 'demo:queried')

    const found = await recorder.store.find(page.data[0].uuid)
    assert.equal(found?.batchId, context.batchId)
  })

  test('recording outside a batch scope lands in the ambient batch', async ({ assert }) => {
    recorder.record(IncomingEntry.make(EntryType.DUMP, { value: 'ambient' }))

    await recorder.flush()

    const page = await recorder.store.list({ type: EntryType.DUMP })

    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].content.value, 'ambient')
    assert.equal(page.data[0].batchId.length, 36)
  })

  test('a flushed batch is readable back out of the sqlite file itself', async ({ assert }) => {
    const context = BatchScope.createContext('command')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.EVENT, { name: 'demo:persisted' }))
      recorder.record(IncomingEntry.make(EntryType.LOG, { level: 'info', message: 'persisted' }))
    })

    await recorder.flush(context)

    /**
     * A second store opened on the same path is the point of the whole test. Reading back through
     * `recorder.store` would pass just as happily against an in-process ring buffer; only a
     * separate connection can show that the bytes reached `tmp/periscope.sqlite` and would still
     * be there after the crash that restarted the application — which is the entire reason
     * `sqlite-local` is the default driver.
     */
    const reader = new SqliteLocalStore({ path: app.tmpPath('periscope.sqlite') })

    try {
      const entries = await reader.batch(context.batchId)

      assert.deepEqual(
        entries.map((entry) => entry.type),
        [EntryType.EVENT, EntryType.LOG]
      )
      assert.equal(entries[0].content.name, 'demo:persisted')
      assert.deepEqual(await reader.counts(), { [EntryType.EVENT]: 1, [EntryType.LOG]: 1 })
    } finally {
      await reader.close()
    }
  })
})
