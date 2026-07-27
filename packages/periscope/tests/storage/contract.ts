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

import { DEFAULT_PAGE_SIZE } from '../../src/storage/pagination.ts'
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
    application: 'default',
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
 * Size of the scale fixture used by the pruning tests. A thousand entries is the number the
 * implementation plan names, and it is the point of those tests: a driver that deletes row by
 * row, or that builds one `in (...)` list out of every doomed uuid, starts to hurt here in a way
 * it never does against the five-entry fixtures above.
 */
const SCALE_ENTRY_COUNT = 1_000

/**
 * How many entries go into one `save()` while seeding. The suite runs against postgres in CI, so
 * seeding with a thousand awaited round trips would dominate the whole run; a handful of calls
 * also matches what a driver actually sees, since every save is one transaction.
 */
const SCALE_SAVE_CHUNK = 250

const HOUR_MS = 3_600_000

/**
 * Epoch of the scale fixture. A fixed instant, not `Date.now()`: a cutoff expressed as "anchor
 * plus N hours" is then exactly reproducible, and a failure is debuggable from the message alone.
 */
const SCALE_ANCHOR = Date.parse('2026-03-01T00:00:00.000Z')

/**
 * The types the scale fixture cycles through. `exception` is in here because the whole point of
 * `keepExceptions` is that one type survives a prune the rest of the history does not, and a
 * fixture of a single type could not tell a driver that spares everything from one that spares
 * the right rows.
 */
const SCALE_TYPES = [
  EntryType.REQUEST,
  EntryType.QUERY,
  EntryType.EXCEPTION,
  EntryType.LOG,
] as const

/**
 * Build {@link SCALE_ENTRY_COUNT} entries, one per hour from {@link SCALE_ANCHOR} onwards and
 * rotating through {@link SCALE_TYPES}.
 *
 * Returned in ascending order of both `createdAt` and `sequence` — the fixture factory advances
 * its sequence clock once per call — so a test can name the expected survivors of any cutoff as
 * a slice of this array, and the expected page as that slice reversed.
 */
function makeScaleEntries(): StoredEntry[] {
  return Array.from({ length: SCALE_ENTRY_COUNT }, (_, index) =>
    makeStoredEntry({
      type: SCALE_TYPES[index % SCALE_TYPES.length],
      createdAt: new Date(SCALE_ANCHOR + index * HOUR_MS),
    })
  )
}

/**
 * Seed `entries` in chunks of {@link SCALE_SAVE_CHUNK}. Sequential rather than concurrent: a
 * driver is free to hold a single connection, and firing four overlapping transactions at one
 * would test the test rather than the contract.
 */
async function seed(store: PeriscopeStore, entries: StoredEntry[]): Promise<void> {
  for (let offset = 0; offset < entries.length; offset += SCALE_SAVE_CHUNK) {
    await store.save(entries.slice(offset, offset + SCALE_SAVE_CHUNK))
  }
}

/**
 * Hard ceiling on how many pages {@link listEverything} will walk before declaring the driver's
 * cursor broken. The largest fixture is {@link SCALE_ENTRY_COUNT} entries at
 * {@link DEFAULT_PAGE_SIZE} per page, plus one for a driver that emits a final empty page.
 */
const MAX_LIST_PAGES = Math.ceil(SCALE_ENTRY_COUNT / DEFAULT_PAGE_SIZE) + 1

/**
 * Walk every page of `list()` and return the entries newest first.
 *
 * The scale tests assert on the *exact* surviving set, which is larger than a page, so they have
 * to paginate. No `limit` is passed, deliberately: `resolvePageSize` clamps any request at or
 * above `MAX_PAGE_SIZE` down to exactly that, and a driver only emits a cursor when a further
 * row exists — so asking for a thousand at a time made the loop run once against a thousand-row
 * fixture and the cursor walk this helper appears to perform never happened. At
 * {@link DEFAULT_PAGE_SIZE} it iterates for real, over the same cursors the dashboard uses.
 */
async function listEverything(store: PeriscopeStore): Promise<StoredEntry[]> {
  const entries: StoredEntry[] = []
  let cursor: string | undefined
  let pages = 0

  do {
    const page = await store.list({ cursor })

    entries.push(...page.data)
    cursor = page.nextCursor ?? undefined
    pages += 1

    /**
     * A driver whose cursor never advances — one that echoes the request, or encodes the newest
     * sequence instead of the page's last — would loop here until the runner killed the process,
     * which reads as an infrastructure hang rather than the driver bug it is. Bounding the walk
     * turns it into a named failure on the eleventh page.
     */
    if (pages > MAX_LIST_PAGES) {
      throw new Error(
        `list() produced more than ${MAX_LIST_PAGES} pages for at most ${SCALE_ENTRY_COUNT} ` +
          `entries: the cursor is not advancing (last cursor ${JSON.stringify(cursor)})`
      )
    }
  } while (cursor !== undefined)

  return entries
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

    test('isolate application filters, summaries, counts, and scoped clear', async ({ assert }) => {
      const alpha = makeStoredEntry({
        application: 'alpha',
        type: EntryType.REQUEST,
        tags: ['alpha-only'],
      })
      const beta = makeStoredEntry({
        application: 'beta',
        type: EntryType.QUERY,
        tags: ['beta-only'],
      })
      await store.save([alpha, beta])
      const alphaPage = await store.list({ application: 'alpha' })
      const applications = await store.applications()

      assert.deepEqual(
        alphaPage.data.map((entry) => entry.uuid),
        [alpha.uuid]
      )
      assert.deepEqual(await store.counts('alpha'), { request: 1 })
      assert.deepEqual(
        applications.map((application) => ({
          name: application.name,
          entries: application.entries,
        })),
        [
          { name: 'beta', entries: 1 },
          { name: 'alpha', entries: 1 },
        ]
      )

      await store.clear('alpha')
      const alphaTags = await store.list({ tag: 'alpha-only' })
      const betaTags = await store.list({ tag: 'beta-only' })

      assert.isNull(await store.find(alpha.uuid))
      assert.isNotNull(await store.find(beta.uuid))
      assert.lengthOf(alphaTags.data, 0)
      assert.lengthOf(betaTags.data, 1)
    })

    /*
     * exception groups
     */

    test('group exception families by their latest occurrence with cursor pagination', async ({
      assert,
    }) => {
      const firstAlpha = makeStoredEntry({
        type: EntryType.EXCEPTION,
        familyHash: 'alpha',
      })
      const beta = makeStoredEntry({
        type: EntryType.EXCEPTION,
        familyHash: 'beta',
      })
      const latestAlpha = makeStoredEntry({
        type: EntryType.EXCEPTION,
        familyHash: 'alpha',
      })

      await store.save([
        firstAlpha,
        makeStoredEntry({ type: EntryType.QUERY, familyHash: 'alpha' }),
        beta,
        makeStoredEntry({ type: EntryType.EXCEPTION, familyHash: null }),
        latestAlpha,
      ])

      const firstPage = await store.exceptionGroups({ limit: 1 })

      assert.lengthOf(firstPage.data, 1)
      assert.equal(firstPage.data[0].familyHash, 'alpha')
      assert.equal(firstPage.data[0].latest.uuid, latestAlpha.uuid)
      assert.equal(firstPage.data[0].count, 2)
      assert.deepEqual(firstPage.data[0].lastSeen, latestAlpha.createdAt)
      assert.isNotNull(firstPage.nextCursor)

      const secondPage = await store.exceptionGroups({
        limit: 1,
        cursor: firstPage.nextCursor ?? undefined,
      })

      assert.lengthOf(secondPage.data, 1)
      assert.equal(secondPage.data[0].familyHash, 'beta')
      assert.equal(secondPage.data[0].latest.uuid, beta.uuid)
      assert.equal(secondPage.data[0].count, 1)
      assert.isNull(secondPage.nextCursor)
    })

    test('filter exception groups by exact tag before aggregating', async ({ assert }) => {
      const taggedAlpha = makeStoredEntry({
        type: EntryType.EXCEPTION,
        familyHash: 'alpha',
        tags: ['tenant:42'],
      })
      const untaggedLatestAlpha = makeStoredEntry({
        type: EntryType.EXCEPTION,
        familyHash: 'alpha',
        tags: ['tenant:7'],
      })
      const taggedBeta = makeStoredEntry({
        type: EntryType.EXCEPTION,
        familyHash: 'beta',
        tags: ['tenant:42'],
      })

      await store.save([taggedAlpha, untaggedLatestAlpha, taggedBeta])

      const page = await store.exceptionGroups({ tag: 'tenant:42' })

      assert.deepEqual(
        page.data.map((exceptionGroup) => exceptionGroup.familyHash),
        ['beta', 'alpha']
      )
      assert.equal(page.data[1].latest.uuid, taggedAlpha.uuid)
      assert.equal(page.data[1].count, 1)
      assert.deepEqual(await store.exceptionGroups({ tag: 'tenant' }), {
        data: [],
        nextCursor: null,
      })
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
     * pruning at scale
     *
     * The three tests below share one fixture — a thousand entries, one per hour, cycling
     * through four types — and are the only place the contract says anything about volume. They
     * exist because the small fixtures above cannot distinguish a correct driver from one that
     * is merely correct on three rows: an off-by-one in a chunked delete, a cap applied to a
     * page instead of to the table, or a `keepExceptions` predicate that a query planner drops
     * once the row count crosses an index threshold all pass everything before this point.
     */

    test('prune a thousand entries by an hours-style cutoff', async ({ assert }) => {
      const entries = makeScaleEntries()

      await seed(store, entries)

      /**
       * `prune` deletes strictly before the cutoff, and entry `n` was created exactly `n` hours
       * after the anchor, so a cutoff of 600 hours must take entries 0..599 and spare entry 600
       * itself. That boundary is the whole reason the cutoff is expressed in fixture terms
       * rather than as a literal date.
       */
      const cutoffHours = 600
      const cutoff = new Date(SCALE_ANCHOR + cutoffHours * HOUR_MS)

      assert.equal(await store.prune({ before: cutoff }), cutoffHours)

      const survivors = await listEverything(store)

      assert.lengthOf(survivors, SCALE_ENTRY_COUNT - cutoffHours)
      assert.deepEqual(
        survivors.map((entry) => entry.uuid),
        entries
          .slice(cutoffHours)
          .map((entry) => entry.uuid)
          .reverse()
      )
    })

    test('spare every exception when pruning a thousand entries', async ({ assert }) => {
      const entries = makeScaleEntries()

      await seed(store, entries)

      const cutoffHours = 750
      const cutoff = new Date(SCALE_ANCHOR + cutoffHours * HOUR_MS)

      const window = entries.slice(0, cutoffHours)
      const sparedExceptions = window.filter((entry) => entry.type === EntryType.EXCEPTION)
      const doomed = window.filter((entry) => entry.type !== EntryType.EXCEPTION)

      assert.isAbove(
        sparedExceptions.length,
        0,
        'the fixture must put exceptions inside the pruned window or this test proves nothing'
      )

      assert.equal(await store.prune({ before: cutoff, keepExceptions: true }), doomed.length)

      const survivors = await listEverything(store)
      const survivingUuids = new Set(survivors.map((entry) => entry.uuid))

      /**
       * Counted rather than looped over, so a driver that spares the wrong rows fails with a
       * number instead of with the first of two hundred identical assertion failures.
       */
      assert.lengthOf(
        sparedExceptions.filter((entry) => !survivingUuids.has(entry.uuid)),
        0,
        'keepExceptions must spare every exception in the window, not merely some of them'
      )
      assert.lengthOf(
        doomed.filter((entry) => survivingUuids.has(entry.uuid)),
        0,
        'everything in the window that is not an exception must be gone'
      )

      assert.deepEqual(
        survivors.map((entry) => entry.uuid),
        entries
          .filter((entry, index) => index >= cutoffHours || entry.type === EntryType.EXCEPTION)
          .map((entry) => entry.uuid)
          .reverse()
      )
    })

    test('trim a thousand entries down to the newest cap', async ({ assert }) => {
      const entries = makeScaleEntries()

      await seed(store, entries)

      const cap = 120

      assert.equal(await store.trim(cap), SCALE_ENTRY_COUNT - cap)

      const survivors = await listEverything(store)

      assert.lengthOf(survivors, cap, 'the cap is exact, not approximate')
      assert.deepEqual(
        survivors.map((entry) => entry.uuid),
        entries
          .slice(-cap)
          .map((entry) => entry.uuid)
          .reverse(),
        'the survivors are the newest entries by sequence'
      )

      /**
       * The entry immediately below the cap is the one an off-by-one keeps or takes one too many
       * of, and `find` reaches it without going through the ordering the assertion above already
       * used.
       */
      assert.isNull(await store.find(entries[SCALE_ENTRY_COUNT - cap - 1].uuid))
      assert.isNotNull(await store.find(entries[SCALE_ENTRY_COUNT - cap].uuid))
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

    test('find any unexpired flag by literal name prefix', async ({ assert }) => {
      await store.setFlag('dump-open:stale', '1', {
        expiresAt: new Date(Date.now() - 60_000),
      })
      await store.setFlag('dump-open:live', '1', {
        expiresAt: new Date(Date.now() + 60_000),
      })
      await store.setFlag('dump%open:wildcard-lookalike', '1')
      await store.setFlag('dumpZZopen:unrelated', '1')

      assert.isTrue(await store.hasFlagWithPrefix('dump-open:'))
      assert.isTrue(await store.hasFlagWithPrefix('dump%open:'))
      assert.isFalse(await store.hasFlagWithPrefix('dump_open:'))
      await store.deleteFlag('dump%open:wildcard-lookalike')
      assert.isFalse(await store.hasFlagWithPrefix('dump%open:'))

      await store.deleteFlag('dump-open:live')

      assert.isFalse(await store.hasFlagWithPrefix('dump-open:'))
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
