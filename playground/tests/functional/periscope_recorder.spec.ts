import { test } from '@japa/runner'
import { setTimeout as sleep } from 'node:timers/promises'
import recorder from 'periscope/services/recorder'
import { BatchScope, EntryType, IncomingEntry, MemoryStore } from 'periscope'

/**
 * The Phase 1 demo (`node ace periscope:demo`) as an assertion, so CI catches a regression in the
 * wiring rather than a human noticing that the demo prints something odd.
 *
 * This is the only test that exercises Periscope through the *published* surface — the package's
 * subpath exports, the provider, `config/periscope.ts` and the container — instead of importing
 * `src/` directly the way the package's own unit tests do. It therefore fails on things the unit
 * suite structurally cannot see: a broken `exports` map, a provider that never binds the recorder,
 * a config file the provider rejects.
 */
test.group('periscope recorder (playground wiring)', () => {
  test('the provider binds a recorder backed by the configured store', ({ assert }) => {
    assert.isTrue(recorder.enabled)

    /**
     * `config/periscope.ts` names the `memory` driver, so this is the assertion that the provider
     * read the config and built what it asked for. It is only meaningful next to the `enabled`
     * assertion above: a *disabled* Periscope is also handed a `MemoryStore`, deliberately, so
     * that switching Periscope off never constructs the configured driver. Enabled plus
     * `MemoryStore` is the pair that proves this store came out of `createStore(config)`.
     */
    assert.instanceOf(recorder.store, MemoryStore)
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
})
