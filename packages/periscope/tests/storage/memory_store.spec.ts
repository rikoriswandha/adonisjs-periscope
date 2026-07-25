/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { randomUUID } from 'node:crypto'

import { test } from '@japa/runner'

import { MemoryStore } from '../../src/storage/memory_store.ts'
import { makeStoredEntry, runStoreContractTests } from './contract.ts'

runStoreContractTests('memory', async () => ({ store: new MemoryStore() }))

/**
 * Everything the shared contract cannot own, because it is a promise the memory driver makes on
 * its own: the ring buffer, the page-size clamp, and the copy-in/copy-out boundary that stands
 * in for the row hydration a SQL driver gets for free.
 */
test.group('MemoryStore', () => {
  test('evict the oldest entries once maxEntries is exceeded', async ({ assert }) => {
    const store = new MemoryStore({ maxEntries: 3 })
    const entries = Array.from({ length: 5 }, () => makeStoredEntry())

    await store.save(entries)

    const page = await store.list()

    assert.deepEqual(
      page.data.map((entry) => entry.uuid),
      [entries[4].uuid, entries[3].uuid, entries[2].uuid]
    )
    assert.isNull(await store.find(entries[0].uuid))
    assert.isNull(await store.find(entries[1].uuid))
  })

  test('enforce the ceiling across separate saves', async ({ assert }) => {
    const store = new MemoryStore({ maxEntries: 2 })
    const first = makeStoredEntry()
    const second = makeStoredEntry()
    const third = makeStoredEntry()

    await store.save([first])
    await store.save([second])
    await store.save([third])

    const page = await store.list()

    assert.deepEqual(
      page.data.map((entry) => entry.uuid),
      [third.uuid, second.uuid]
    )
  })

  test('drop evicted entries out of the tag and batch indexes', async ({ assert }) => {
    const store = new MemoryStore({ maxEntries: 2 })
    const batchId = randomUUID()
    const evicted = makeStoredEntry({ batchId, tags: ['doomed'] })
    const kept = makeStoredEntry({ batchId, tags: ['kept'] })
    const alsoKept = makeStoredEntry({ batchId, tags: ['kept'] })

    await store.save([evicted, kept, alsoKept])

    const tagged = await store.list({ tag: 'doomed' })
    const batch = await store.batch(batchId)
    const counts = await store.counts()

    assert.isNull(await store.find(evicted.uuid))
    assert.lengthOf(tagged.data, 0)
    assert.deepEqual(
      batch.map((entry) => entry.uuid),
      [kept.uuid, alsoKept.uuid]
    )
    assert.equal(counts.request, 2)
  })

  test('fall back to the default ceiling for a non-positive maxEntries', async ({ assert }) => {
    const store = new MemoryStore({ maxEntries: 0 })

    await store.save(Array.from({ length: 5 }, () => makeStoredEntry()))

    const page = await store.list()

    assert.lengthOf(page.data, 5)
  })

  test('ignore a mutation of the entry object made after it was saved', async ({ assert }) => {
    const store = new MemoryStore()
    const entry = makeStoredEntry({ tags: ['original'], familyHash: 'before' })

    await store.save([entry])

    entry.tags.push('injected')
    entry.familyHash = 'after'
    entry.shouldDisplayOnIndex = false
    entry.createdAt.setFullYear(1999)

    const found = await store.find(entry.uuid)
    const injected = await store.list({ tag: 'injected' })

    assert.isNotNull(found)
    assert.deepEqual(found?.tags, ['original'])
    assert.equal(found?.familyHash, 'before')
    assert.isTrue(found?.shouldDisplayOnIndex)
    assert.notEqual(found?.createdAt.getFullYear(), 1999)
    assert.lengthOf(injected.data, 0)
  })

  test('ignore a mutation of an entry handed back by a read', async ({ assert }) => {
    const store = new MemoryStore()
    const entry = makeStoredEntry({ tags: ['original'] })

    await store.save([entry])

    const first = await store.find(entry.uuid)
    first?.tags.push('injected')

    const page = await store.list()
    page.data[0].tags.push('also-injected')

    const second = await store.find(entry.uuid)

    assert.deepEqual(second?.tags, ['original'])
  })

  test('default to a page of a hundred entries', async ({ assert }) => {
    const store = new MemoryStore()

    await store.save(Array.from({ length: 150 }, () => makeStoredEntry()))

    const page = await store.list()

    assert.lengthOf(page.data, 100)
    assert.isNotNull(page.nextCursor)
  })

  test('clamp an oversized limit to a thousand entries', async ({ assert }) => {
    const store = new MemoryStore({ maxEntries: 1_200 })

    await store.save(Array.from({ length: 1_100 }, () => makeStoredEntry()))

    const page = await store.list({ limit: 10_000 })

    assert.lengthOf(page.data, 1_000)
    assert.isNotNull(page.nextCursor)
  })

  test('replace an entry saved twice under the same uuid', async ({ assert }) => {
    const store = new MemoryStore()
    const original = makeStoredEntry({ tags: ['first'] })
    const replacement = { ...original, tags: ['second'] }

    await store.save([original])
    await store.save([replacement])

    const found = await store.find(original.uuid)
    const stale = await store.list({ tag: 'first' })
    const current = await store.list({ tag: 'second' })
    const page = await store.list()

    assert.deepEqual(found?.tags, ['second'])
    assert.lengthOf(stale.data, 0)
    assert.lengthOf(current.data, 1)
    assert.lengthOf(page.data, 1)
  })
})
