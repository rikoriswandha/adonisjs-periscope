/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { clearInterval, setInterval } from 'node:timers'

import { IncomingEntry } from '../entry.ts'
import { safeguard, safeguardAsync } from '../safeguard.ts'
import { EntryType, Flag } from '../types.ts'
import type {
  BatchContext,
  BatchEntryView,
  BatchKind,
  BatchView,
  FilterHook,
  FlushedEvent,
  FlushedListener,
  PeriscopeStore,
  ResolvedPeriscopeConfig,
  StoredEntry,
  TagHook,
} from '../types.ts'
import { AmbientBatch } from './ambient.ts'
import { BatchScope } from './context.ts'
import { Redactor } from './redactor.ts'
import { nextSequence } from './sequence.ts'

/**
 * The entry that *is* the batch, per batch kind — the one a dashboard user opens to see what the
 * batch was, and therefore the one the truncation note belongs on. A batch with no natural
 * headline entry (`test`, and the rotating `ambient` batch, which is a bag of unrelated
 * activity) has no mapping; the note falls back to the first drained entry.
 */
const PRIMARY_ENTRY_TYPE: Record<BatchKind, EntryType | undefined> = {
  request: EntryType.REQUEST,
  command: EntryType.COMMAND,
  queue: EntryType.JOB,
  test: undefined,
  ambient: undefined,
}

/**
 * Reserved key under which the per-batch cap overflow counts are reported. Documented on
 * {@link EntryContent}: watchers must not use it for their own payload.
 */
const TRUNCATED_KEY = 'truncated'

/**
 * Tag put on the entry carrying a truncation note, so the dashboard can surface "this batch lost
 * entries to a cap" without parsing content.
 */
const TRUNCATED_TAG = 'truncated'

/**
 * Exact tag persisted on every query in a repeated family once the configured threshold is met.
 */
const N_PLUS_ONE_TAG = 'n+1'

/**
 * Message carried by the synthetic entry minted when a truncation report has nothing to ride on.
 * A `log` is the closest thing Periscope has to "there is something you should know about this
 * batch", and the dashboard renders a log by its message, so the note says it in prose rather
 * than hiding entirely inside {@link TRUNCATED_KEY}.
 */
const TRUNCATION_MESSAGE = 'Periscope dropped entries in this batch after a per-type cap was hit.'

/**
 * A monitored-tag read may be reused for at most ten seconds.
 */
export const MONITORED_TAGS_CACHE_TTL_MS = 10_000
const MONITORED_TAGS_CACHE_TTL_NS = BigInt(MONITORED_TAGS_CACHE_TTL_MS) * 1_000_000n

/**
 * Intermediate flushes may stream sampled-in batches, but sampled-out batches need their whole
 * context intact until a final flush can make one sticky retention decision.
 */
export type FlushMode = 'intermediate' | 'final'

export type RecorderOptions = {
  config: ResolvedPeriscopeConfig
  store: PeriscopeStore

  /**
   * Overrides `config.enabled`. The provider passes the environment-gated value computed by
   * `isRecordingEnabled`, so a package enabled in config but running in production stays off.
   */
  enabled?: boolean
}

/**
 * Remove `hook` from `hooks` exactly once.
 *
 * The latch is not paranoia: without it, calling the unregister function twice removes a
 * *different* registration when the same function object was registered more than once (a
 * watcher re-registering a shared predicate, say). An unregister function owns its own
 * registration and nothing else, so a second call must be a no-op.
 */
function unregisterHook<T>(hooks: T[], hook: T): () => void {
  let registered = true

  return () => {
    if (!registered) {
      return
    }

    registered = false

    const index = hooks.indexOf(hook)
    if (index !== -1) {
      hooks.splice(index, 1)
    }
  }
}

/**
 * Run every filter hook, reporting whether one of them vetoed the entry.
 *
 * A hook that throws is treated as having no opinion rather than as a rejection. Host
 * applications write these, and a buggy predicate must not silently switch recording off — nor
 * may it escape into the watcher that called `record()` (§0, invariant 1), hence the safeguard.
 */
function rejectedByHooks(hooks: readonly FilterHook[], entry: IncomingEntry): boolean {
  for (const hook of hooks) {
    if (safeguard('periscope.recorder.filter', () => hook(entry)) === false) {
      return true
    }
  }

  return false
}

/**
 * Run every tag hook and append what they return. Hooks run after redaction, so they can key off
 * content without a secret ending up in a tag; a throwing hook simply contributes nothing.
 */
function applyTagHooks(hooks: readonly TagHook[], entry: IncomingEntry): void {
  for (const hook of hooks) {
    const tags = safeguard('periscope.recorder.tag', () => hook(entry))

    if (Array.isArray(tags)) {
      entry.withTags(...tags)
    }
  }
}

class FlushingBatchView implements BatchView {
  readonly kind: BatchKind
  readonly #entries: readonly IncomingEntry[]

  constructor(kind: BatchKind, entries: readonly IncomingEntry[]) {
    this.kind = kind
    this.#entries = entries
  }

  get size(): number {
    return this.#entries.length
  }

  hasEntryOfType(type: EntryType): boolean {
    return this.#entries.some((entry) => entry.type === type)
  }

  hasTag(tag: string): boolean {
    return this.#entries.some((entry) => entry.tags.includes(tag))
  }

  hasEntryWhere(predicate: (entry: BatchEntryView) => boolean): boolean {
    return this.#entries.some(predicate)
  }
}

/**
 * The recorder: the single point every watcher hands entries to, and the only thing that writes
 * to the store.
 *
 * It owns the pipeline described in architecture §6.1 and nothing else — no transport, no
 * schema, no knowledge of what a "query" or a "request" is. Watchers decide *what* to record,
 * the recorder decides *whether* and *when*, and the store decides *where*.
 *
 * Two invariants from plan §0 shape almost every decision in here:
 *
 * 1. **Periscope never throws into host-app code paths.** `record()` is called from inside a
 *    query listener, an exception reporter, a middleware — code the host owns. So `record()`
 *    returns `void`, swallows everything, and `flush()` never rejects even when the store is
 *    broken.
 * 2. **Periscope never records itself.** The store's own queries and logs would otherwise be
 *    recorded by the very flush that persists them, which recurses. Every store write happens
 *    inside `BatchScope.mute()`.
 */
export class Recorder {
  /**
   * The storage driver. Public because the dashboard, the ace commands and the provider's
   * automatic retention task all read through the same instance the recorder writes with.
   * Its lifetime is owned by the provider — {@link Recorder.shutdown} deliberately does not
   * close it.
   */
  readonly store: PeriscopeStore

  /**
   * The redactor the record pipeline scrubs content with.
   *
   * Public because watchers need it for the values that never reach `record()` as content:
   * HTTP headers, which have their own deny list and their own `redactHeaders` walk. Handing
   * the same instance out is what keeps a watcher from constructing a second one — two
   * redactors mean two chances for a configuration change to reach only one of them.
   */
  readonly redactor: Redactor

  readonly #config: ResolvedPeriscopeConfig
  readonly #enabled: boolean
  readonly #ambient: AmbientBatch

  /**
   * Hooks registered at runtime through {@link Recorder.filter} and {@link Recorder.tag}, kept
   * apart from the configured ones so that unregistering cannot mutate the user's config array.
   * Configured hooks always run first.
   */
  readonly #filterHooks: FilterHook[] = []
  readonly #tagHooks: TagHook[] = []

  readonly #flushedListeners: FlushedListener[] = []

  /**
   * Monitored tags are cold-path storage state. The last successful set and in-flight promise
   * make concurrent sampled-out flushes share one muted read. `null` means storage has never
   * supplied a value, rather than an empty monitored set.
   */
  #monitoredTags: ReadonlySet<string> | null = null
  #monitoredTagsExpiresAt = 0n
  #monitoredTagsRefresh: Promise<ReadonlySet<string> | null> | null = null

  /**
   * Cached value of the `paused` flag. The lifecycle poll refreshes it independently of entries,
   * so the first entry after an idle period observes a value no older than the configured window.
   */
  #paused = false

  /**
   * The pause refresh timer and its in-flight read. The timer is lifecycle-owned and the promise
   * serializes slow store reads: interval ticks reuse the current read rather than piling up.
   */
  #pausedTimer: NodeJS.Timeout | null = null
  #pausedRefresh: Promise<void> | null = null

  /**
   * Per-context flushes are serialized so leaving entries buffered until a save commits cannot
   * make two callers persist the same fragment. The set gives shutdown one place to drain every
   * flush before the provider closes storage.
   */
  readonly #contextFlushes = new WeakMap<BatchContext, Promise<void>>()
  readonly #inFlightFlushes = new Set<Promise<void>>()
  #trimRequested = false
  #trimmingStore: Promise<void> | null = null

  /**
   * Recorder caps already bound accepted entries per type. One extra slot carries the synthetic
   * truncation report, keeping a failed-save requeue bounded even when every type cap is full.
   */
  readonly #bufferLimit: number

  /**
   * Memoised shutdown, which is what makes {@link Recorder.shutdown} idempotent: a second caller
   * awaits the first stop instead of starting another one.
   */
  #shuttingDown: Promise<void> | null = null

  constructor(options: RecorderOptions) {
    this.store = options.store
    this.#config = options.config
    this.#bufferLimit =
      Object.values(options.config.recording.caps).reduce((total, cap) => total + cap, 0) + 1
    this.#enabled = options.enabled ?? options.config.enabled
    this.redactor = new Redactor(options.config.redact)
    BatchScope.configureSampling(options.config.recording.sampleRate)
    this.#ambient = new AmbientBatch({
      rotationMs: options.config.recording.ambientRotationMs,
      flush: (context) => this.flush(context),
    })
  }

  /**
   * Whether this recorder records at all. Fixed at construction: the provider resolves the
   * environment gate once, and a per-entry re-check would only add a branch to the hot path.
   */
  get enabled(): boolean {
    return this.#enabled
  }

  /**
   * Whether recording is paused by `node ace periscope:pause`.
   *
   * The flag lives in the store, which is asynchronous, while `record()` is synchronous and must
   * stay that way — a watcher cannot await, and making the hot path await a database round trip
   * per entry would be absurd. The lifecycle poll refreshes this cached value at
   * `recording.pausedFlagTtlMs` intervals, including while the application is idle, so this getter
   * remains a cheap field read and a later entry cannot be the trigger for its own refresh.
   *
   * A store that throws leaves the previous value in place. Failing closed — treating an
   * unreachable store as "paused" — would silently stop recording exactly when something is
   * already wrong and the entries matter most.
   */
  get paused(): boolean {
    return this.#paused
  }

  /**
   * Subscribe to content-free index rows after they have been persisted successfully.
   */
  subscribeFlushed(listener: FlushedListener): () => void {
    this.#flushedListeners.push(listener)
    return unregisterHook(this.#flushedListeners, listener)
  }

  #refreshPaused(): Promise<void> {
    if (this.#pausedRefresh !== null) {
      return this.#pausedRefresh
    }

    const refresh = safeguardAsync('periscope.recorder.paused', async () => {
      /**
       * §0, invariant 2, exactly as in {@link Recorder.flush}: this is a store read like any
       * other, and the driver's own query and log traffic is observable by the watchers feeding
       * this recorder.
       */
      this.#paused = (await BatchScope.mute(() => this.store.getFlag(Flag.PAUSED))) !== null
    })

    this.#pausedRefresh = refresh
    void refresh.then(() => {
      if (this.#pausedRefresh === refresh) {
        this.#pausedRefresh = null
      }
    })

    return refresh
  }

  #readMonitoredTags(): Promise<ReadonlySet<string> | null> {
    if (process.hrtime.bigint() < this.#monitoredTagsExpiresAt) {
      return Promise.resolve(this.#monitoredTags)
    }

    if (this.#monitoredTagsRefresh !== null) {
      return this.#monitoredTagsRefresh
    }

    const refresh = (async (): Promise<ReadonlySet<string> | null> => {
      const tags = await safeguardAsync('periscope.recorder.monitored_tags', () =>
        BatchScope.mute(() => this.store.monitoredTags())
      )

      if (tags === undefined) {
        /**
         * Preserve the last successful read and leave its expiry untouched so the next flush
         * retries storage. `null` deliberately survives only when storage has never been readable.
         */
        return this.#monitoredTags
      }

      this.#monitoredTags = new Set(tags)
      this.#monitoredTagsExpiresAt = process.hrtime.bigint() + MONITORED_TAGS_CACHE_TTL_NS
      return this.#monitoredTags
    })()

    this.#monitoredTagsRefresh = refresh
    void refresh.then(() => {
      if (this.#monitoredTagsRefresh === refresh) {
        this.#monitoredTagsRefresh = null
      }
    })

    return refresh
  }

  #notifyFlushed(entry: StoredEntry): void {
    if (!entry.shouldDisplayOnIndex || this.#flushedListeners.length === 0) {
      return
    }

    const indexRow = Object.freeze({
      uuid: entry.uuid,
      batchId: entry.batchId,
      application: entry.application,
      type: entry.type,
      familyHash: entry.familyHash,
      tags: Object.freeze([...entry.tags]),
      shouldDisplayOnIndex: true as const,
      sequence: entry.sequence.toString(),
      createdAt: entry.createdAt.toISOString(),
    })
    const event: FlushedEvent = Object.freeze({
      type: entry.type,
      uuid: entry.uuid,
      indexRow,
    })

    for (const listener of [...this.#flushedListeners]) {
      const pending = safeguard('periscope.recorder.flushed', () => listener(event))

      if (pending !== null && (typeof pending === 'object' || typeof pending === 'function')) {
        void safeguardAsync('periscope.recorder.flushed', () => Promise.resolve(pending))
      }
    }
  }

  /**
   * Capture the context an asynchronous watcher should keep targeting after its originating
   * callback returns. Request work retains the active scope; work started outside one retains
   * the current ambient generation rather than whichever generation is current when it ends.
   */
  captureContext(): BatchContext {
    return BatchScope.current() ?? this.#ambient.current()
  }

  /**
   * Push an entry through the pipeline and, if it survives, into the active batch's buffer.
   *
   * The order is architecture §6.1 and is not negotiable, because each step depends on the one
   * before it:
   *
   * ```
   * muted -> enabled/paused -> filter hooks -> redaction -> tag hooks -> caps -> buffer push
   * ```
   *
   * The cheap unconditional drops come first so a muted or disabled recorder costs almost
   * nothing. Filters run *before* redaction: dropping is cheaper than scrubbing, and a filter
   * often keys off precisely the raw values redaction would erase. Tag hooks run *after* it, so
   * a tag can never leak a secret. Caps are charged last, against entries that actually made it,
   * so a filtered-out entry does not eat a slot.
   *
   * Nothing here can throw: watchers call this from host-owned code paths (§0, invariant 1).
   */
  record(entry: IncomingEntry): void {
    safeguard('periscope.recorder.record', () => {
      const context = BatchScope.current() ?? this.#ambient.current()

      if (context.muted) {
        return
      }

      if (!this.enabled || this.paused) {
        return
      }

      if (
        rejectedByHooks(this.#config.hooks.filter, entry) ||
        rejectedByHooks(this.#filterHooks, entry)
      ) {
        return
      }

      entry.content = this.redactor.redact(entry.content)

      applyTagHooks(this.#config.hooks.tag, entry)
      applyTagHooks(this.#tagHooks, entry)

      const cap = this.#config.recording.caps[entry.type]
      const accepted = context.counters[entry.type] ?? 0

      if (accepted >= cap) {
        context.truncated[entry.type] = (context.truncated[entry.type] ?? 0) + 1
        return
      }

      context.counters[entry.type] = accepted + 1

      entry.stamp(context.batchId, nextSequence())
      context.buffer.push(entry)
    })
  }

  /**
   * Flush one buffered fragment from `target`, defaulting to the active batch. `final` is the
   * default lifecycle boundary; `intermediate` keeps an undecided sampled-out context intact.
   * Every successful write also restores the `storage.maxEntries` ceiling.
   *
   * Never rejects: the request middleware awaits this on the way out of every request, and a
   * broken store must not turn into a 500.
   */
  flush(target?: BatchContext, mode: FlushMode = 'final'): Promise<void> {
    const context = target ?? BatchScope.current() ?? this.#ambient.current()
    const previous = this.#contextFlushes.get(context)
    const pending = (async (): Promise<void> => {
      if (previous !== undefined) {
        await previous
      }

      await safeguardAsync('periscope.recorder.flush', () => this.#flushContext(context, mode))
    })()

    this.#contextFlushes.set(context, pending)
    this.#inFlightFlushes.add(pending)
    void pending.then(() => {
      if (this.#contextFlushes.get(context) === pending) {
        this.#contextFlushes.delete(context)
      }
      this.#inFlightFlushes.delete(pending)
    })

    return pending
  }

  async #flushContext(context: BatchContext, mode: FlushMode): Promise<void> {
    /**
     * An intermediate flush cannot decide a sampled-out batch from one fragment. Leaving the
     * buffer and truncation counters in place lets the final flush expose the whole context to
     * keepAlways and monitored-tag matching. Sampled-in contexts still take the streaming path.
     */
    if (!context.sampled && context.retention === 'pending' && mode === 'intermediate') {
      return
    }

    /**
     * Keep the fragment in the context until storage confirms it. Concurrent records append
     * behind this snapshot, while the per-context queue above prevents a second flush from
     * replaying it. Restoring a failed save pays off when an intermediate flush still has a later
     * flush coming; the final flush is the last chance, and its failure loses the fragment with
     * the context.
     */
    const drained = context.buffer.slice()
    let bufferedEntries = drained.length

    /**
     * Reported before the empty-buffer bail-out. A flush with nothing to write can still owe a
     * truncation report because every entry of a capped type may have been dropped.
     */
    this.#reportTruncation(context, drained)

    /**
     * N+1 classification belongs to the final, complete batch rather than an intermediate
     * fragment. Apply it before sampling retention so both keepAlways and monitored tags can
     * retain a sampled-out offending batch.
     */
    if (mode === 'final') {
      this.#tagNPlusOneQueries(drained)
    }

    if (drained.length === 0) {
      if (!context.sampled && context.retention === 'pending') {
        context.retention = 'dropped'
      }

      return
    }

    if (!context.sampled) {
      if (context.retention === 'dropped') {
        context.buffer.splice(0, bufferedEntries)
        return
      }

      if (context.retention === 'pending') {
        const batchView = new FlushingBatchView(context.kind, drained)
        let kept =
          safeguard(
            'periscope.recorder.keep_always',
            () => this.#config.recording.keepAlways(batchView),
            false
          ) === true

        if (!kept) {
          const monitoredTags = await this.#readMonitoredTags()
          const entriesBeforeRefresh = drained.length
          const arrivals = context.buffer.slice(bufferedEntries)

          /**
           * Captured-context watchers may record while the monitored-tag read is in flight. Fold
           * those entries into the same final decision without removing them before persistence.
           */
          drained.push(...arrivals)
          bufferedEntries += arrivals.length
          this.#reportTruncation(context, drained)

          if (mode === 'final' && drained.length !== entriesBeforeRefresh) {
            this.#tagNPlusOneQueries(drained)
          }

          if (drained.length !== entriesBeforeRefresh) {
            kept =
              safeguard(
                'periscope.recorder.keep_always',
                () => this.#config.recording.keepAlways(batchView),
                false
              ) === true
          }

          /**
           * `null` means no monitored-tag read has ever succeeded. That one case deliberately
           * fails open; after the first success, read failures reuse the last-known set instead.
           */
          kept ||=
            monitoredTags === null ||
            batchView.hasEntryWhere((entry) => entry.tags.some((tag) => monitoredTags.has(tag)))
        }

        context.retention = kept ? 'kept' : 'dropped'

        if (!kept) {
          context.buffer.splice(0)
          return
        }
      }
    }

    const stored = drained.map((entry) => entry.toStored(this.#config.applicationName))

    try {
      /**
       * The driver's own work is observable by the watchers feeding this recorder. Muting the
       * write stops a flush from generating entries for the next flush.
       */
      await BatchScope.mute(() => this.store.save(stored))
    } catch (error) {
      /**
       * Normal buffered entries never left the context. A synthetic truncation entry is the one
       * possible exception, so restore any missing drained entries in order, then enforce the
       * same fixed ceiling as the normal record path.
       */
      const queued = new Set(context.buffer)
      for (let index = drained.length - 1; index >= 0; index -= 1) {
        const entry = drained[index]
        if (!queued.has(entry) && context.buffer.length < this.#bufferLimit) {
          context.buffer.unshift(entry)
          queued.add(entry)
        }
      }
      if (context.buffer.length > this.#bufferLimit) {
        context.buffer.splice(this.#bufferLimit)
      }

      throw error
    }

    /**
     * Only the entries represented by this successful write leave the buffer. Anything recorded
     * while the save was in flight remains for the next serialized flush.
     */
    context.buffer.splice(0, bufferedEntries)

    for (const entry of stored) {
      this.#notifyFlushed(entry)
    }

    /**
     * `maxEntries` is a hard retention ceiling. Each successful write therefore performs the
     * driver's cheap under-cap check and trims immediately when necessary.
     */
    await this.#trimStore()
  }

  #trimStore(): Promise<void> {
    this.#trimRequested = true

    if (this.#trimmingStore !== null) {
      return this.#trimmingStore
    }

    const trimming = (async () => {
      while (this.#trimRequested) {
        this.#trimRequested = false
        await BatchScope.mute(() => this.store.trim(this.#config.storage.maxEntries))
      }
    })()
    this.#trimmingStore = trimming

    const settled = () => {
      if (this.#trimmingStore === trimming) {
        this.#trimmingStore = null
      }
    }
    void trimming.then(settled, settled)

    return trimming
  }

  /**
   * Run `fn` with recording suppressed. Handed to watchers and to the dashboard's own controller
   * code, which must not record the queries it runs to display recordings.
   */
  mute<T>(fn: () => T): T {
    return BatchScope.mute(fn)
  }

  /**
   * Register a filter hook, returning a function that unregisters it. Runs after the hooks from
   * `config.hooks.filter`.
   */
  filter(hook: FilterHook): () => void {
    this.#filterHooks.push(hook)
    return unregisterHook(this.#filterHooks, hook)
  }

  /**
   * Register a tag hook, returning a function that unregisters it. Runs after the hooks from
   * `config.hooks.tag`.
   */
  tag(hook: TagHook): () => void {
    this.#tagHooks.push(hook)
    return unregisterHook(this.#tagHooks, hook)
  }

  /**
   * Start the pause-state poll and rotating ambient batch.
   *
   * A disabled recorder never buffers anything, so it arms no timer at all. That keeps the
   * "Periscope off costs nothing" promise literal rather than approximate. Both lifecycle timers
   * are idempotent and unref'ed, so repeated readiness cannot duplicate work and neither timer
   * keeps an otherwise-finished process alive.
   */
  start(): void {
    if (!this.#enabled || this.#pausedTimer !== null) {
      return
    }

    /**
     * Starting again makes the previous shutdown history. Without this, the memo in
     * {@link Recorder.shutdown} would still hold the resolved promise of the *first* stop, and a
     * second `shutdown()` would resolve instantly against it while the timers armed below kept
     * running. {@link AmbientBatch} is restartable, so the recorder around it must be too.
     */
    this.#shuttingDown = null

    this.#pausedTimer = setInterval(() => {
      void this.#refreshPaused()
    }, this.#config.recording.pausedFlagTtlMs)
    this.#pausedTimer.unref()

    /**
     * Seed the cache at lifecycle start rather than waiting one whole window. `#refreshPaused`
     * memoises the in-flight read, so even a very short interval cannot overlap this initial one.
     */
    void this.#refreshPaused()
    this.#ambient.start()
  }

  /**
   * Stop the pause poll, wait for its current muted read, then stop the ambient batch, whose stop
   * performs the final flush.
   *
   * Waiting for the read is part of ownership: provider teardown may close the store as soon as
   * this resolves, so no lifecycle task may still be using it. The store itself is intentionally
   * left open because the provider owns it. Calling this twice is safe.
   */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown === null) {
      if (this.#pausedTimer !== null) {
        clearInterval(this.#pausedTimer)
        this.#pausedTimer = null
      }

      const pausedRefresh = this.#pausedRefresh
      this.#shuttingDown = safeguardAsync('periscope.recorder.shutdown', async () => {
        await pausedRefresh

        while (this.#inFlightFlushes.size > 0) {
          await Promise.all(this.#inFlightFlushes)
        }

        await this.#ambient.stop()
      })
    }

    await this.#shuttingDown
  }

  /**
   * Count queries by their watcher-provided family hash, then tag every member of families
   * meeting the configured threshold. The second linear pass avoids retaining a second array of
   * entry references for every family. Queries without a family hash cannot identify a repeated
   * shape and are intentionally ignored.
   */
  #tagNPlusOneQueries(entries: readonly IncomingEntry[]): void {
    const familyCounts = new Map<string, number>()

    for (const entry of entries) {
      if (entry.type !== EntryType.QUERY || entry.familyHash === null) {
        continue
      }

      familyCounts.set(entry.familyHash, (familyCounts.get(entry.familyHash) ?? 0) + 1)
    }

    for (const entry of entries) {
      if (
        entry.type === EntryType.QUERY &&
        entry.familyHash !== null &&
        familyCounts.get(entry.familyHash)! >= this.#config.dashboard.nPlusOneThreshold
      ) {
        entry.withTags(N_PLUS_ONE_TAG)
      }
    }
  }

  /**
   * Fold the batch's cap-overflow counts into the entry a user will actually look at, so a
   * truncated batch says so instead of just appearing to have done less work than it did.
   *
   * The counts are moved, not copied: `context.truncated` is replaced with a fresh object so a
   * later flush of the same context (a long-lived ambient batch, a middleware flushing twice)
   * cannot report the same drops again. `counters` are deliberately left alone — caps are per
   * batch, not per flush, so flushing must not hand a batch a fresh allowance.
   *
   * When the flush drained nothing there is no entry to fold the counts into, and the note gets
   * an entry of its own, appended to `drained` so the caller writes it like any other. Holding
   * the counts back for "the next flush that has something" is not a fix: a request batch flushes
   * once and is then never heard from again, so a deferred note and a lost note are the same
   * note. The synthetic entry is hidden from the index screens — it is a fact about one batch,
   * not a log line the application produced — so it only surfaces in that batch's timeline.
   *
   * The note is written into a *copy* of the carrier's content, never into the object itself.
   * A custom redaction policy may disable both key and value scanning, in which case the entry
   * still holds the exact object supplied by the host application. Periscope observes; it does
   * not add keys to things it was merely shown.
   */
  #reportTruncation(context: BatchContext, drained: IncomingEntry[]): void {
    const truncated = context.truncated

    if (Object.keys(truncated).length === 0) {
      return
    }

    context.truncated = {}

    const primaryType = PRIMARY_ENTRY_TYPE[context.kind]
    const carrier =
      (primaryType === undefined
        ? undefined
        : drained.find((entry) => entry.type === primaryType)) ?? drained.at(0)

    if (carrier === undefined) {
      drained.push(
        IncomingEntry.make(EntryType.LOG, {
          message: TRUNCATION_MESSAGE,
          [TRUNCATED_KEY]: truncated,
        })
          .withTags(TRUNCATED_TAG)
          .hiddenFromIndex()
          .stamp(context.batchId, nextSequence())
      )

      return
    }

    carrier.content = { ...carrier.content, [TRUNCATED_KEY]: truncated }
    carrier.withTags(TRUNCATED_TAG)
  }
}
