/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { EntryType } from '../types.ts'
import { encodeEntryCursor, parseEntryCursor, resolvePageSize } from './pagination.ts'
import { aggregateExceptionGroups } from './exception_groups.ts'
import type {
  ApplicationSummary,
  EntryQuery,
  ExceptionGroup,
  ExceptionGroupQuery,
  EntryTypeCounts,
  FlagOptions,
  Paginated,
  PeriscopeStore,
  PruneOptions,
  StoredEntry,
} from '../types.ts'
import type { EntryCursor } from './pagination.ts'

/**
 * Ceiling used when the caller gives none. Matches `storage.maxEntries` in the resolved config,
 * so a `MemoryStore` built by hand behaves like one built by the provider.
 */
const DEFAULT_MAX_ENTRIES = 10_000

/**
 * Shared empty candidate set, returned when an index lookup misses. Saves an allocation on what
 * is otherwise the most common query in a fresh application: a filter that matches nothing.
 */
const NO_CANDIDATES: ReadonlySet<string> = new Set()

/**
 * A flag plus its absolute expiry in epoch milliseconds, or `null` when it never expires. Stored
 * as a number rather than a `Date` because it is only ever compared against `Date.now()`.
 */
type StoredFlag = { value: string; expiresAt: number | null }

/**
 * Options accepted by {@link MemoryStore}.
 */
export type MemoryStoreOptions = {
  /**
   * Hard ceiling on retained entries; the oldest are evicted once it is exceeded. A non-positive
   * or non-finite value falls back to {@link DEFAULT_MAX_ENTRIES} rather than turning the store
   * into a black hole that silently swallows everything recorded.
   */
  maxEntries?: number
}

/**
 * Compare two entries oldest-first. `bigint` cannot be subtracted into the `number` an
 * `Array#sort` comparator has to return, so the branches are spelled out.
 */
function bySequenceAscending(left: StoredEntry, right: StoredEntry): number {
  if (left.sequence === right.sequence) {
    if (left.uuid === right.uuid) {
      return 0
    }
    return left.uuid < right.uuid ? -1 : 1
  }

  return left.sequence < right.sequence ? -1 : 1
}

/**
 * Compare two entries newest-first — the order every index screen renders.
 */
function bySequenceDescending(left: StoredEntry, right: StoredEntry): number {
  if (left.sequence === right.sequence) {
    if (left.uuid === right.uuid) {
      return 0
    }
    return left.uuid > right.uuid ? -1 : 1
  }

  return left.sequence > right.sequence ? -1 : 1
}

/**
 * Test every filter of a query against one entry.
 *
 * Filters that an index already narrowed on are re-checked here on purpose: the indexes are an
 * optimisation, the predicate is the definition. Keeping the two separate means an index bug can
 * only ever cost recall, never return an entry that does not match.
 */
function matchesQuery(entry: StoredEntry, query: EntryQuery, cursor: EntryCursor | null): boolean {
  if (
    cursor !== null &&
    (entry.sequence > cursor.sequence ||
      (entry.sequence === cursor.sequence && (cursor.uuid === null || entry.uuid >= cursor.uuid)))
  ) {
    return false
  }

  if (query.type !== undefined && entry.type !== query.type) {
    return false
  }

  if (query.batchId !== undefined && entry.batchId !== query.batchId) {
    return false
  }

  if (query.application !== undefined && entry.application !== query.application) {
    return false
  }

  if (query.familyHash !== undefined && entry.familyHash !== query.familyHash) {
    return false
  }

  if (query.displayOnIndex !== undefined && entry.shouldDisplayOnIndex !== query.displayOnIndex) {
    return false
  }

  if (query.tag !== undefined && !entry.tags.includes(query.tag)) {
    return false
  }

  return true
}

/**
 * The in-process storage driver — the `memory` value of `StorageDriverName`.
 *
 * It is both Periscope's test double and a driver applications actually run: zero dependencies,
 * zero configuration, and perfectly adequate for a single-process dev server or an ephemeral CI
 * container where losing the data on restart is the point. So it is written as a real driver,
 * not as a toy that happens to satisfy the tests.
 *
 * Design notes, in the order they matter:
 *
 * - **Ring buffer.** `maxEntries` is a hard ceiling, not a hint. A watcher storm in a dev server
 *   must cost bounded memory, so `save` evicts the oldest entries as soon as the ceiling is
 *   exceeded.
 * - **Three indexes, one removal path.** The primary `Map<uuid, StoredEntry>` is joined by a tag
 *   index and a batch index, and the failure mode this design invites is a uuid left behind in
 *   one of them after the entry is gone. Every deletion — eviction, prune, trim, overwrite —
 *   therefore funnels through the single private `#remove`, and `clear` resets all three
 *   together. Nothing else may call `Map#delete` on `#entries`.
 * - **Ordering is explicit, never insertion order.** The recorder stamps sequences monotonically
 *   within one process, but workers may tie; reads therefore sort by `(sequence, uuid)`.
 *   Eviction is the one deliberate exception: it pops the front of insertion order in O(1), which
 *   is correct for the recorder's normal write path. `trim` is an explicit maintenance operation
 *   allowed to cost more, so it resolves the composite order exactly.
 * - **Copy in, copy out.** Entries are cloned on the way in, so a watcher that keeps mutating an
 *   object after handing it over cannot rewrite history, and cloned on the way out, so the
 *   dashboard cannot mutate the buffer through a result. The clone is shallow plus a fresh
 *   `tags` array and `createdAt`; `content` is deliberately shared by reference. It is a
 *   redacted, already-serialised payload that is immutable by convention, it is by far the
 *   largest part of an entry, and deep-cloning it on every page render would make the memory
 *   driver the slowest one Periscope ships. The SQL drivers hydrate fresh rows and therefore get
 *   the same isolation for free — matching them here is what keeps the shared contract suite
 *   honest.
 */
export class MemoryStore implements PeriscopeStore {
  readonly #maxEntries: number

  /**
   * Primary index, in insertion order. See the class note: insertion order is used for eviction
   * only, never for read ordering.
   */
  readonly #entries = new Map<string, StoredEntry>()

  readonly #byTag = new Map<string, Set<string>>()
  readonly #byBatch = new Map<string, Set<string>>()

  /**
   * User intent rather than recorded data, which is why `clear` leaves both alone.
   */
  readonly #monitoredTags = new Set<string>()
  readonly #flags = new Map<string, StoredFlag>()

  constructor(options: MemoryStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES

    this.#maxEntries =
      Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_MAX_ENTRIES
  }

  /**
   * Clone an entry across the storage boundary. See the class note on "copy in, copy out" for
   * why `content` is the one field carried by reference.
   */
  #copy(entry: StoredEntry): StoredEntry {
    return {
      uuid: entry.uuid,
      batchId: entry.batchId,
      application: entry.application,
      type: entry.type,
      familyHash: entry.familyHash,
      content: entry.content,
      tags: [...entry.tags],
      shouldDisplayOnIndex: entry.shouldDisplayOnIndex,
      sequence: entry.sequence,
      createdAt: new Date(entry.createdAt.getTime()),
    }
  }

  /**
   * Store one entry and index it.
   *
   * Re-saving a known uuid replaces the previous version. Removing it first is what stops the
   * tag index from keeping tags the new version no longer carries — an append-only index would
   * make the old tag match forever.
   */
  #insert(entry: StoredEntry): void {
    this.#remove(entry.uuid)

    const stored = this.#copy(entry)
    this.#entries.set(stored.uuid, stored)

    for (const tag of stored.tags) {
      let tagged = this.#byTag.get(tag)

      if (tagged === undefined) {
        tagged = new Set()
        this.#byTag.set(tag, tagged)
      }

      tagged.add(stored.uuid)
    }

    let batched = this.#byBatch.get(stored.batchId)

    if (batched === undefined) {
      batched = new Set()
      this.#byBatch.set(stored.batchId, batched)
    }

    batched.add(stored.uuid)
  }

  /**
   * The only way an entry ever leaves the store. Drops it from the primary index and from every
   * secondary index, deleting index buckets once they empty so a long-lived process does not
   * accumulate one entry per tag it has ever seen.
   */
  #remove(uuid: string): void {
    const entry = this.#entries.get(uuid)

    if (entry === undefined) {
      return
    }

    this.#entries.delete(uuid)

    for (const tag of entry.tags) {
      const tagged = this.#byTag.get(tag)

      if (tagged !== undefined && tagged.delete(uuid) && tagged.size === 0) {
        this.#byTag.delete(tag)
      }
    }

    const batched = this.#byBatch.get(entry.batchId)

    if (batched !== undefined && batched.delete(uuid) && batched.size === 0) {
      this.#byBatch.delete(entry.batchId)
    }
  }

  /**
   * Narrow a query down to the uuids worth testing. Batch and tag are the only selective
   * indexes; everything else scans, which is what a bounded ring buffer is for.
   */
  #candidates(query: EntryQuery): Iterable<string> {
    if (query.batchId !== undefined) {
      return this.#byBatch.get(query.batchId) ?? NO_CANDIDATES
    }

    if (query.tag !== undefined) {
      return this.#byTag.get(query.tag) ?? NO_CANDIDATES
    }

    return this.#entries.keys()
  }

  *#candidateEntries(query: EntryQuery): IterableIterator<StoredEntry> {
    for (const uuid of this.#candidates(query)) {
      const entry = this.#entries.get(uuid)

      if (entry !== undefined) {
        yield entry
      }
    }
  }

  async save(entries: StoredEntry[]): Promise<void> {
    if (entries.length === 0) {
      return
    }

    for (const entry of entries) {
      this.#insert(entry)
    }

    /*
     * Evict once per batch rather than once per entry: the batch is written as a unit and the
     * ceiling only has to hold afterwards. Deleting the key the iterator is sitting on is
     * well-defined for a `Map`, and the iteration walks insertion order, so this pops the oldest
     * entries first.
     */
    for (const uuid of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) {
        break
      }

      this.#remove(uuid)
    }
  }

  async find(uuid: string): Promise<StoredEntry | null> {
    const entry = this.#entries.get(uuid)

    return entry === undefined ? null : this.#copy(entry)
  }

  async list(query: EntryQuery = {}): Promise<Paginated<StoredEntry>> {
    const limit = resolvePageSize(query.limit)
    const cursor = parseEntryCursor(query.cursor)
    const matches: StoredEntry[] = []

    for (const entry of this.#candidateEntries(query)) {
      if (matchesQuery(entry, query, cursor)) {
        matches.push(entry)
      }
    }

    matches.sort(bySequenceDescending)

    const page = matches.slice(0, limit)

    /*
     * The cursor is only handed out when a further entry actually exists, so the page carrying
     * the last entry always reports `null` — a caller walking pages never has to fetch an empty
     * one to discover it is done.
     */
    return {
      data: page.map((entry) => this.#copy(entry)),
      nextCursor:
        matches.length > limit
          ? encodeEntryCursor(page[page.length - 1].sequence, page[page.length - 1].uuid)
          : null,
    }
  }

  async batch(batchId: string): Promise<StoredEntry[]> {
    const uuids = this.#byBatch.get(batchId)

    if (uuids === undefined) {
      return []
    }

    const entries: StoredEntry[] = []

    for (const uuid of uuids) {
      const entry = this.#entries.get(uuid)

      if (entry !== undefined) {
        entries.push(entry)
      }
    }

    // Oldest first: the batch screen is a timeline, the opposite of every index screen.
    entries.sort(bySequenceAscending)

    return entries.map((entry) => this.#copy(entry))
  }

  async counts(application?: string): Promise<EntryTypeCounts> {
    const counts: EntryTypeCounts = {}

    for (const entry of this.#entries.values()) {
      if (application === undefined || entry.application === application) {
        counts[entry.type] = (counts[entry.type] ?? 0) + 1
      }
    }

    return counts
  }

  async applications(): Promise<ApplicationSummary[]> {
    const summaries = new Map<string, ApplicationSummary>()

    for (const entry of this.#entries.values()) {
      const summary = summaries.get(entry.application)
      if (summary === undefined) {
        summaries.set(entry.application, {
          name: entry.application,
          entries: 1,
          latestAt: new Date(entry.createdAt.getTime()),
        })
      } else {
        summary.entries += 1
        if (summary.latestAt === null || entry.createdAt > summary.latestAt) {
          summary.latestAt = new Date(entry.createdAt.getTime())
        }
      }
    }

    return [...summaries.values()].sort((left, right) => {
      const byLatest = (right.latestAt?.getTime() ?? 0) - (left.latestAt?.getTime() ?? 0)
      return byLatest === 0 ? left.name.localeCompare(right.name) : byLatest
    })
  }

  async exceptionGroups(query: ExceptionGroupQuery = {}): Promise<Paginated<ExceptionGroup>> {
    const entries = [...this.#candidateEntries(query)].filter(
      (entry) => query.application === undefined || entry.application === query.application
    )
    const page = aggregateExceptionGroups(entries, query)

    return {
      data: page.data.map((group) => ({
        familyHash: group.familyHash,
        latest: this.#copy(group.latest),
        count: group.count,
        lastSeen: new Date(group.lastSeen.getTime()),
      })),
      nextCursor: page.nextCursor,
    }
  }

  async prune(options: PruneOptions): Promise<number> {
    const before = options.before.getTime()
    const doomed: string[] = []

    for (const entry of this.#entries.values()) {
      if (entry.createdAt.getTime() >= before) {
        continue
      }

      if (options.keepExceptions === true && entry.type === EntryType.EXCEPTION) {
        continue
      }

      doomed.push(entry.uuid)
    }

    for (const uuid of doomed) {
      this.#remove(uuid)
    }

    return doomed.length
  }

  async trim(maxEntries: number): Promise<number> {
    const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 0
    const excess = this.#entries.size - cap

    if (excess <= 0) {
      return 0
    }

    /*
     * Unlike eviction, `trim` is an explicit maintenance command and cannot assume the buffer
     * was filled in stamping order, so "oldest" uses the full `(sequence, uuid)` key.
     */
    const doomed = [...this.#entries.values()].sort(bySequenceAscending).slice(0, excess)

    for (const entry of doomed) {
      this.#remove(entry.uuid)
    }

    return doomed.length
  }

  async clear(application?: string): Promise<void> {
    if (application === undefined) {
      this.#entries.clear()
      this.#byTag.clear()
      this.#byBatch.clear()
      return
    }

    for (const entry of [...this.#entries.values()]) {
      if (entry.application === application) {
        this.#remove(entry.uuid)
      }
    }
  }

  async monitoredTags(): Promise<string[]> {
    return [...this.#monitoredTags]
  }

  async monitorTag(tag: string): Promise<void> {
    this.#monitoredTags.add(tag)
  }

  async unmonitorTag(tag: string): Promise<void> {
    this.#monitoredTags.delete(tag)
  }

  async getFlag(name: string): Promise<string | null> {
    const flag = this.#flags.get(name)

    if (flag === undefined) {
      return null
    }

    /*
     * Expiry is lazy: there is no timer to leak and no wheel to drain at shutdown, and the flags
     * this backs — `paused`, `dump-open` — are read far more often than they are set.
     */
    if (flag.expiresAt !== null && flag.expiresAt <= Date.now()) {
      this.#flags.delete(name)

      return null
    }

    return flag.value
  }

  async hasFlagWithPrefix(prefix: string): Promise<boolean> {
    const now = Date.now()

    for (const [name, flag] of this.#flags) {
      if (flag.expiresAt !== null && flag.expiresAt <= now) {
        this.#flags.delete(name)
        continue
      }

      if (name.startsWith(prefix)) {
        return true
      }
    }

    return false
  }

  async setFlag(name: string, value: string, options: FlagOptions = {}): Promise<void> {
    // A whole new record, so setting a flag without an expiry clears whatever expiry it had.
    this.#flags.set(name, { value, expiresAt: options.expiresAt?.getTime() ?? null })
  }

  async deleteFlag(name: string): Promise<void> {
    this.#flags.delete(name)
  }

  /**
   * Nothing to release: the whole store dies with the instance. It exists so the provider's
   * shutdown path is identical across drivers, and it is idempotent because shutdown can run
   * more than once — a test closing explicitly, then the provider closing again.
   */
  async close(): Promise<void> {}
}
