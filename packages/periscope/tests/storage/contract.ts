/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The shared storage contract suite (implementation plan P1.4).
 *
 * Every driver Periscope ships — `memory` now, `sqlite-local` and `database` in P2 — must behave
 * identically from the dashboard's point of view, so the behaviour is specified once, here, and
 * each driver's own spec file only supplies a factory. The file is deliberately named
 * `contract.ts` and not `*.spec.ts`: the Japa runner globs `tests/**\/*.spec.ts`, so this module
 * only ever runs through a driver spec that calls {@link runStoreContractTests}.
 *
 * Because it outlives the memory driver, nothing in here may assume memory semantics:
 *
 * - every store method is awaited; no read is treated as synchronous,
 * - what comes back out of a store is never assumed to be the object that went in (a SQL driver
 *   hydrates fresh rows), so assertions compare values and uuids, never identity,
 * - `sequence` values are never assumed contiguous — the fixture factory below advances by a
 *   stride larger than one precisely so a driver that tries to derive "the next cursor"
 *   arithmetically fails loudly instead of passing by luck.
 */

import { randomUUID } from 'node:crypto'

import { test } from '@japa/runner'

import { EntryType, Flag } from '../../src/types.ts'
import type { PeriscopeStore, StoredEntry } from '../../src/types.ts'

/**
 * How a driver spec hands the suite a store. `cleanup` is optional so the memory driver can skip
 * it while a file-backed driver removes its database between tests.
 */
export type StoreFactory = () => Promise<{ store: PeriscopeStore; cleanup?: () => Promise<void> }>

/**
 * Gap between two consecutive fixture sequences. Anything but `1`: production sequences are
 * nanosecond stamps and are never contiguous, and neither this suite nor a driver may pretend
 * otherwise.
 */
const SEQUENCE_STRIDE = 977n

/**
 * Fixture clocks, anchored once per process so fixtures look like real recorder output:
 * `sequence` is a nanosecond-resolution wall-clock stamp, `createdAt` a millisecond `Date`. Both
 * advance strictly, which is what lets a test predict "newest first" from call order alone.
 */
let lastSequence = BigInt(Date.now()) * 1_000_000n
let lastCreatedAt = Date.now()

/**
 * Build a {@link StoredEntry} fixture. Every field has a usable default and every default is
 * overridable; `uuid` and `batchId` are unique per call so a test that cares about grouping has
 * to say so explicitly rather than inherit it by accident.
 */
export function makeStoredEntry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  lastSequence += SEQUENCE_STRIDE
  lastCreatedAt += 1

  return {
    uuid: randomUUID(),
    batchId: randomUUID(),
    type: EntryType.REQUEST,
    familyHash: null,
    content: {},
    tags: [],
    shouldDisplayOnIndex: true,
    sequence: lastSequence,
    createdAt: new Date(lastCreatedAt),
    ...overrides,
  }
}

/**
 * Read an entry the test knows must be there. Turns a driver that lost the entry into a readable
 * failure instead of a `TypeError` three lines later, and keeps the assertions below free of
 * non-null assertions.
 */
async function findOrFail(store: PeriscopeStore, uuid: string): Promise<StoredEntry> {
  const entry = await store.find(uuid)

  if (entry === null) {
    throw new Error(`Expected the store to contain entry ${uuid}`)
  }

  return entry
}

/**
 * Register the whole storage contract against one driver. Call it from a `*.spec.ts` file:
 *
 * ```ts
 * runStoreContractTests('memory', async () => ({ store: new MemoryStore() }))
 * ```
 *
 * Each test gets a store of its own, so no test can observe another's entries, flags or
 * monitored tags.
 */
export function runStoreContractTests(driverName: string, createStore: StoreFactory): void {
  test.group(`Storage contract (${driverName})`, (group) => {
    let store: PeriscopeStore
    let cleanup: (() => Promise<void>) | undefined

    group.each.setup(async () => {
      const created = await createStore()
      store = created.store
      cleanup = created.cleanup
    })

    group.each.teardown(async () => {
      await store.close()
      await cleanup?.()
    })

    /*
     * save
     */

    test('persist a batch and read every entry of it back', async ({ assert }) => {
      const batchId = randomUUID()
      const first = makeStoredEntry({ batchId })
      const second = makeStoredEntry({ batchId })

      await store.save([first, second])

      const page = await store.list()

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [second.uuid, first.uuid]
      )
    })

    test('accept an empty batch without throwing', async ({ assert }) => {
      await store.save([])

      assert.deepEqual(await store.list(), { data: [], nextCursor: null })
    })

    test('round-trip every field with its own type', async ({ assert }) => {
      const entry = makeStoredEntry({
        type: EntryType.QUERY,
        familyHash: 'select-from-users',
        content: { sql: 'select * from users', bindings: [1, 'two'], nested: { deep: true } },
        tags: ['connection:pg', 'slow'],
        shouldDisplayOnIndex: false,
      })

      await store.save([entry])

      const found = await findOrFail(store, entry.uuid)

      assert.equal(found.uuid, entry.uuid)
      assert.equal(found.batchId, entry.batchId)
      assert.equal(found.type, EntryType.QUERY)
      assert.equal(found.familyHash, 'select-from-users')
      assert.deepEqual(found.content, {
        sql: 'select * from users',
        bindings: [1, 'two'],
        nested: { deep: true },
      })
      assert.deepEqual(found.tags, ['connection:pg', 'slow'])
      assert.isFalse(found.shouldDisplayOnIndex)
      assert.equal(typeof found.sequence, 'bigint')
      assert.strictEqual(found.sequence, entry.sequence)
      assert.instanceOf(found.createdAt, Date)
      assert.equal(found.createdAt.getTime(), entry.createdAt.getTime())
    })

    test('store a missing family hash as null rather than as a string', async ({ assert }) => {
      const entry = makeStoredEntry({ familyHash: null })

      await store.save([entry])

      const found = await findOrFail(store, entry.uuid)

      assert.isNull(found.familyHash)
    })

    /*
     * find
     */

    test('resolve null for an unknown uuid', async ({ assert }) => {
      await store.save([makeStoredEntry()])

      assert.isNull(await store.find(randomUUID()))
    })

    /*
     * list
     */

    test('order entries newest first by sequence', async ({ assert }) => {
      const oldest = makeStoredEntry()
      const middle = makeStoredEntry()
      const newest = makeStoredEntry()

      // Written out of order on purpose: ordering is a property of `sequence`, never of the
      // order rows happened to be inserted in.
      await store.save([middle, newest, oldest])

      const page = await store.list()

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [newest.uuid, middle.uuid, oldest.uuid]
      )
    })

    test('treat a missing query as no filters at all', async ({ assert }) => {
      const request = makeStoredEntry({ type: EntryType.REQUEST })
      const query = makeStoredEntry({ type: EntryType.QUERY })
      const log = makeStoredEntry({ type: EntryType.LOG })

      await store.save([request, query, log])

      const page = await store.list()

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [log.uuid, query.uuid, request.uuid]
      )
    })

    test('return an empty page for an empty store', async ({ assert }) => {
      assert.deepEqual(await store.list(), { data: [], nextCursor: null })
    })

    test('filter by type', async ({ assert }) => {
      const request = makeStoredEntry({ type: EntryType.REQUEST })
      const query = makeStoredEntry({ type: EntryType.QUERY })

      await store.save([request, query])

      const matching = await store.list({ type: EntryType.QUERY })
      const empty = await store.list({ type: EntryType.MAIL })

      assert.deepEqual(
        matching.data.map((entry) => entry.uuid),
        [query.uuid]
      )
      assert.lengthOf(empty.data, 0)
    })

    test('filter by tag', async ({ assert }) => {
      const tagged = makeStoredEntry({ tags: ['status:500', 'slow'] })
      const other = makeStoredEntry({ tags: ['status:200'] })

      await store.save([tagged, other])

      const slow = await store.list({ tag: 'slow' })
      const ok = await store.list({ tag: 'status:200' })
      const unknown = await store.list({ tag: 'never-used' })

      assert.deepEqual(
        slow.data.map((entry) => entry.uuid),
        [tagged.uuid]
      )
      assert.deepEqual(
        ok.data.map((entry) => entry.uuid),
        [other.uuid]
      )
      assert.lengthOf(unknown.data, 0)
    })

    test('filter by family hash', async ({ assert }) => {
      const grouped = makeStoredEntry({ familyHash: 'abc' })
      const other = makeStoredEntry({ familyHash: 'def' })
      const ungrouped = makeStoredEntry({ familyHash: null })

      await store.save([grouped, other, ungrouped])

      const page = await store.list({ familyHash: 'abc' })

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [grouped.uuid]
      )
    })

    test('filter by batch id', async ({ assert }) => {
      const batchId = randomUUID()
      const first = makeStoredEntry({ batchId })
      const second = makeStoredEntry({ batchId })
      const foreign = makeStoredEntry()

      await store.save([first, second, foreign])

      const page = await store.list({ batchId })
      const unknown = await store.list({ batchId: randomUUID() })

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [second.uuid, first.uuid]
      )
      assert.lengthOf(unknown.data, 0)
    })

    test('exclude hidden entries when displayOnIndex is true', async ({ assert }) => {
      const visible = makeStoredEntry()
      const hidden = makeStoredEntry({ shouldDisplayOnIndex: false })

      await store.save([visible, hidden])

      const page = await store.list({ displayOnIndex: true })

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [visible.uuid]
      )
    })

    test('return only hidden entries when displayOnIndex is false', async ({ assert }) => {
      const visible = makeStoredEntry()
      const hidden = makeStoredEntry({ shouldDisplayOnIndex: false })

      await store.save([visible, hidden])

      const page = await store.list({ displayOnIndex: false })

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [hidden.uuid]
      )
    })

    test('combine every filter with AND', async ({ assert }) => {
      const batchId = randomUUID()
      const base = { batchId, type: EntryType.QUERY, tags: ['slow'], familyHash: 'abc' }

      const match = makeStoredEntry(base)
      const wrongType = makeStoredEntry({ ...base, type: EntryType.LOG })
      const wrongTag = makeStoredEntry({ ...base, tags: ['fast'] })
      const wrongHash = makeStoredEntry({ ...base, familyHash: 'def' })
      const wrongBatch = makeStoredEntry({ ...base, batchId: randomUUID() })
      const hidden = makeStoredEntry({ ...base, shouldDisplayOnIndex: false })

      await store.save([match, wrongType, wrongTag, wrongHash, wrongBatch, hidden])

      const page = await store.list({
        batchId,
        type: EntryType.QUERY,
        tag: 'slow',
        familyHash: 'abc',
        displayOnIndex: true,
      })

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [match.uuid]
      )
    })

    test('cap the page at the requested limit', async ({ assert }) => {
      const entries = Array.from({ length: 5 }, () => makeStoredEntry())

      await store.save(entries)

      const page = await store.list({ limit: 2 })

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [entries[4].uuid, entries[3].uuid]
      )
      assert.isNotNull(page.nextCursor)
    })

    test('ignore a non-positive limit', async ({ assert }) => {
      await store.save(Array.from({ length: 3 }, () => makeStoredEntry()))

      const zero = await store.list({ limit: 0 })
      const negative = await store.list({ limit: -5 })

      assert.lengthOf(zero.data, 3)
      assert.lengthOf(negative.data, 3)
    })

    test('visit every entry exactly once when walking pages with the cursor', async ({
      assert,
    }) => {
      const entries = Array.from({ length: 7 }, () => makeStoredEntry())

      await store.save(entries)

      const seen: string[] = []
      let cursor: string | null = null
      let pages = 0

      for (;;) {
        const page = await store.list({ limit: 3, cursor: cursor ?? undefined })

        seen.push(...page.data.map((entry) => entry.uuid))
        cursor = page.nextCursor
        pages += 1

        if (cursor === null) {
          break
        }

        assert.isBelow(pages, 10, 'cursor pagination did not terminate')
      }

      assert.deepEqual(
        seen,
        [...entries].reverse().map((entry) => entry.uuid)
      )
      assert.equal(pages, 3)
    })

    test('resolve a null cursor on a last page that is exactly full', async ({ assert }) => {
      const entries = Array.from({ length: 4 }, () => makeStoredEntry())

      await store.save(entries)

      const first = await store.list({ limit: 2 })
      assert.isNotNull(first.nextCursor)

      const second = await store.list({ limit: 2, cursor: first.nextCursor ?? undefined })

      assert.deepEqual(
        second.data.map((entry) => entry.uuid),
        [entries[1].uuid, entries[0].uuid]
      )
      assert.isNull(second.nextCursor)
    })

    test('keep applying filters while paginating', async ({ assert }) => {
      const first = makeStoredEntry({ type: EntryType.QUERY })
      const second = makeStoredEntry({ type: EntryType.QUERY })
      const noise = makeStoredEntry({ type: EntryType.LOG })
      const third = makeStoredEntry({ type: EntryType.QUERY })

      await store.save([first, second, noise, third])

      const page = await store.list({ type: EntryType.QUERY, limit: 2 })
      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [third.uuid, second.uuid]
      )
      assert.isNotNull(page.nextCursor)

      const next = await store.list({
        type: EntryType.QUERY,
        limit: 2,
        cursor: page.nextCursor ?? undefined,
      })

      assert.deepEqual(
        next.data.map((entry) => entry.uuid),
        [first.uuid]
      )
      assert.isNull(next.nextCursor)
    })

    test('ignore an unparseable cursor instead of throwing', async ({ assert }) => {
      const entry = makeStoredEntry()

      await store.save([entry])

      const page = await store.list({ cursor: 'not-a-cursor' })

      assert.deepEqual(
        page.data.map((item) => item.uuid),
        [entry.uuid]
      )
    })

    /*
     * batch
     */

    test('return a batch ordered by sequence ascending', async ({ assert }) => {
      const batchId = randomUUID()
      const first = makeStoredEntry({ batchId })
      const second = makeStoredEntry({ batchId })
      const third = makeStoredEntry({ batchId })
      const foreign = makeStoredEntry()

      // The timeline reads oldest-first, the opposite of `list`, so no driver can satisfy both
      // with a single ordering.
      await store.save([third, first, foreign, second])

      const entries = await store.batch(batchId)

      assert.deepEqual(
        entries.map((entry) => entry.uuid),
        [first.uuid, second.uuid, third.uuid]
      )
    })

    test('return an empty array for an unknown batch id', async ({ assert }) => {
      await store.save([makeStoredEntry()])

      assert.deepEqual(await store.batch(randomUUID()), [])
    })

    /*
     * counts
     */

    test('count entries per type', async ({ assert }) => {
      await store.save([
        makeStoredEntry({ type: EntryType.REQUEST }),
        makeStoredEntry({ type: EntryType.QUERY }),
        makeStoredEntry({ type: EntryType.QUERY }),
      ])

      const counts = await store.counts()

      assert.equal(counts.request, 1)
      assert.equal(counts.query, 2)

      // A type with no entries may be omitted or reported as zero; both are conforming.
      assert.isNotOk(counts.log)
    })

    /*
     * prune
     */

    test('delete entries created strictly before the cutoff', async ({ assert }) => {
      const cutoff = new Date('2026-01-02T00:00:00.000Z')
      const older = makeStoredEntry({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
      const onCutoff = makeStoredEntry({ createdAt: new Date(cutoff.getTime()) })
      const newer = makeStoredEntry({ createdAt: new Date('2026-01-03T00:00:00.000Z') })

      await store.save([older, onCutoff, newer])

      assert.equal(await store.prune({ before: cutoff }), 1)

      const page = await store.list()

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [newer.uuid, onCutoff.uuid]
      )
    })

    test('spare exception entries when keepExceptions is set', async ({ assert }) => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z')
      const request = makeStoredEntry({ type: EntryType.REQUEST, createdAt })
      const exception = makeStoredEntry({ type: EntryType.EXCEPTION, createdAt })

      await store.save([request, exception])

      const deleted = await store.prune({
        before: new Date('2026-06-01T00:00:00.000Z'),
        keepExceptions: true,
      })

      assert.equal(deleted, 1)
      assert.isNull(await store.find(request.uuid))
      assert.isNotNull(await store.find(exception.uuid))
    })

    test('remove pruned entries from every lookup', async ({ assert }) => {
      const batchId = randomUUID()
      const pruned = makeStoredEntry({
        batchId,
        tags: ['doomed'],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      const kept = makeStoredEntry({
        batchId,
        tags: ['kept'],
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
      })

      await store.save([pruned, kept])

      assert.equal(await store.prune({ before: new Date('2026-01-02T00:00:00.000Z') }), 1)
      assert.isNull(await store.find(pruned.uuid))

      const page = await store.list()
      const tagged = await store.list({ tag: 'doomed' })
      const batch = await store.batch(batchId)
      const counts = await store.counts()

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [kept.uuid]
      )
      assert.lengthOf(tagged.data, 0)
      assert.deepEqual(
        batch.map((entry) => entry.uuid),
        [kept.uuid]
      )
      assert.equal(counts.request, 1)
    })

    test('delete nothing when no entry predates the cutoff', async ({ assert }) => {
      const entry = makeStoredEntry({ createdAt: new Date('2026-01-03T00:00:00.000Z') })

      await store.save([entry])

      assert.equal(await store.prune({ before: new Date('2026-01-01T00:00:00.000Z') }), 0)
      assert.isNotNull(await store.find(entry.uuid))
    })

    /*
     * trim
     */

    test('trim the oldest entries until the cap is met', async ({ assert }) => {
      const entries = Array.from({ length: 5 }, () => makeStoredEntry())

      await store.save(entries)

      assert.equal(await store.trim(2), 3)

      const page = await store.list()

      assert.deepEqual(
        page.data.map((entry) => entry.uuid),
        [entries[4].uuid, entries[3].uuid]
      )
      assert.isNull(await store.find(entries[0].uuid))
    })

    test('return zero when the store is already under the cap', async ({ assert }) => {
      await store.save([makeStoredEntry(), makeStoredEntry()])

      assert.equal(await store.trim(5), 0)

      const page = await store.list()

      assert.lengthOf(page.data, 2)
    })

    /*
     * clear
     */

    test('remove every entry and every index on clear', async ({ assert }) => {
      const batchId = randomUUID()
      const entry = makeStoredEntry({ batchId, tags: ['gone'] })

      await store.save([entry])
      await store.clear()

      const page = await store.list()
      const tagged = await store.list({ tag: 'gone' })
      const counts = await store.counts()

      assert.deepEqual(page, { data: [], nextCursor: null })
      assert.lengthOf(tagged.data, 0)
      assert.isNotOk(counts.request)
      assert.isNull(await store.find(entry.uuid))
      assert.deepEqual(await store.batch(batchId), [])
    })

    test('keep monitored tags and flags across a clear', async ({ assert }) => {
      await store.save([makeStoredEntry({ tags: ['keep-me'] })])
      await store.monitorTag('keep-me')
      await store.setFlag(Flag.PAUSED, '1')

      await store.clear()

      assert.deepEqual(await store.monitoredTags(), ['keep-me'])
      assert.equal(await store.getFlag(Flag.PAUSED), '1')
    })

    /*
     * monitoring
     */

    test('report a monitored tag', async ({ assert }) => {
      await store.monitorTag('slow')

      assert.include(await store.monitoredTags(), 'slow')
    })

    test('not duplicate a tag monitored twice', async ({ assert }) => {
      await store.monitorTag('slow')
      await store.monitorTag('slow')

      const tags = await store.monitoredTags()

      assert.lengthOf(
        tags.filter((tag) => tag === 'slow'),
        1
      )
    })

    test('stop reporting an unmonitored tag', async ({ assert }) => {
      await store.monitorTag('slow')
      await store.monitorTag('flaky')
      await store.unmonitorTag('slow')

      const tags = await store.monitoredTags()

      assert.notInclude(tags, 'slow')
      assert.include(tags, 'flaky')
    })

    test('ignore unmonitoring a tag that was never monitored', async ({ assert }) => {
      await store.unmonitorTag('never-monitored')

      assert.deepEqual(await store.monitoredTags(), [])
    })

    /*
     * flags
     */

    test('resolve null for an unset flag', async ({ assert }) => {
      assert.isNull(await store.getFlag(Flag.PAUSED))
    })

    test('round-trip a flag value', async ({ assert }) => {
      await store.setFlag(Flag.PAUSED, 'yes')

      assert.equal(await store.getFlag(Flag.PAUSED), 'yes')
      assert.isNull(await store.getFlag(Flag.DUMP_OPEN))
    })

    test('replace the value and the expiry when a flag is set again', async ({ assert }) => {
      await store.setFlag(Flag.DUMP_OPEN, 'first', { expiresAt: new Date(Date.now() - 60_000) })
      await store.setFlag(Flag.DUMP_OPEN, 'second', { expiresAt: new Date(Date.now() + 60_000) })

      assert.equal(await store.getFlag(Flag.DUMP_OPEN), 'second')
    })

    test('clear a previous expiry when a flag is set without one', async ({ assert }) => {
      await store.setFlag(Flag.DUMP_OPEN, 'first', { expiresAt: new Date(Date.now() - 60_000) })
      assert.isNull(await store.getFlag(Flag.DUMP_OPEN))

      await store.setFlag(Flag.DUMP_OPEN, 'second')

      assert.equal(await store.getFlag(Flag.DUMP_OPEN), 'second')
    })

    test('treat a flag whose expiry has passed as absent', async ({ assert }) => {
      await store.setFlag(Flag.DUMP_OPEN, 'stale', { expiresAt: new Date(Date.now() - 1) })

      assert.isNull(await store.getFlag(Flag.DUMP_OPEN))
    })

    test('read back a flag whose expiry is still in the future', async ({ assert }) => {
      await store.setFlag(Flag.DUMP_OPEN, 'live', { expiresAt: new Date(Date.now() + 60_000) })

      assert.equal(await store.getFlag(Flag.DUMP_OPEN), 'live')
    })

    test('delete a flag', async ({ assert }) => {
      await store.setFlag(Flag.PAUSED, 'yes')
      await store.deleteFlag(Flag.PAUSED)

      assert.isNull(await store.getFlag(Flag.PAUSED))
    })

    test('ignore deleting a flag that was never set', async ({ assert }) => {
      await store.deleteFlag('never-set')

      assert.isNull(await store.getFlag('never-set'))
    })

    /*
     * close
     */

    test('resolve close and tolerate being closed twice', async ({ assert }) => {
      await store.close()

      await assert.doesNotReject(() => store.close())
    })
  })
}
