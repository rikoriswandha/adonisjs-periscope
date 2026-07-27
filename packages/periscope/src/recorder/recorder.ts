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
 * Message carried by the synthetic entry minted when a truncation report has nothing to ride on.
 * A `log` is the closest thing Periscope has to "there is something you should know about this
 * batch", and the dashboard renders a log by its message, so the note says it in prose rather
 * than hiding entirely inside {@link TRUNCATED_KEY}.
 */
const TRUNCATION_MESSAGE = 'Periscope dropped entries in this batch after a per-type cap was hit.'

/**
 * How many *successful* flushes pass between two opportunistic `store.trim()` calls.
 *
 * `storage.maxEntries` is a ceiling on retained history, not a per-write invariant, so trimming
 * on every flush would be indefensible: a flush costs one insert on a request's way out, while a
 * trim is a whole-table maintenance delete. Twenty-five is chosen to be invisible from both
 * sides of that trade. One extra statement per twenty-five flushes disappears into the writes
 * those same flushes already do, and an application recording a handful of entries per request
 * can only carry a few hundred rows past the cap before the next trim pulls it back — an
 * overshoot of a few percent on a ten-thousand-entry default, which is exactly the accuracy a
 * "keep roughly the last N entries" knob deserves.
 *
 * There is deliberately no config key for it. The interval schedules an intent the user already
 * expressed through `storage.maxEntries`; a second knob would only let someone mis-tune the
 * first. Config surface arrives the day something needs to override it. It is exported only so
 * the suite that proves the interval can assert against the number instead of duplicating it.
 */
export const TRIM_EVERY_FLUSHES = 25

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
   * The storage driver. Public because the dashboard, the ace commands and the pruning
   * scheduler all read through the same instance the recorder writes with, and because its
   * lifetime is owned by the provider — {@link Recorder.shutdown} deliberately does not close
   * it.
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
   * Monitored tags are cold-path storage state. The set and in-flight promise make concurrent
   * sampled-out flushes share one muted read.
   */
  #monitoredTags = new Set<string>()
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
   * Successful flushes since the last opportunistic trim — see {@link TRIM_EVERY_FLUSHES}.
   *
   * It lives on the recorder rather than on a batch context because contexts are short-lived:
   * a request batch flushes exactly once, so a per-context counter would never reach any
   * interval worth having and every request would trim.
   */
  #flushesSinceTrim = 0

  /**
   * Memoised shutdown, which is what makes {@link Recorder.shutdown} idempotent: a second caller
   * awaits the first stop instead of starting another one.
   */
  #shuttingDown: Promise<void> | null = null

  constructor(options: RecorderOptions) {
    this.store = options.store
    this.#config = options.config
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
   * Whether recording is paused by `node ace periscope:pause` (P5.3).
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
        return null
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
   * Every {@link TRIM_EVERY_FLUSHES} successful writes also bring the store back under
   * `storage.maxEntries`.
   *
   * Never rejects: the request middleware awaits this on the way out of every request, and a
   * broken store must not turn into a 500.
   */
  async flush(target?: BatchContext, mode: FlushMode = 'final'): Promise<void> {
    await safeguardAsync('periscope.recorder.flush', async () => {
      const context = target ?? BatchScope.current() ?? this.#ambient.current()

      /**
       * An intermediate flush cannot decide a sampled-out batch from one fragment. Leaving the
       * buffer and truncation counters in place lets the final flush expose the whole context to
       * keepAlways and monitored-tag matching. Sampled-in contexts still take the streaming path
       * below without delay.
       */
      if (!context.sampled && context.retention === 'pending' && mode === 'intermediate') {
        return
      }

      /**
       * Drained synchronously, before the first `await`. Anything recorded while the store write
       * is in flight lands in a fresh buffer and is picked up by the next flush, and a second
       * flush racing this one finds nothing — entries can be neither written twice nor lost.
       */
      const drained = context.buffer.splice(0)

      /**
       * Reported *before* the empty-buffer bail-out. A flush with nothing to write can still owe
       * a truncation report: the batch may have had every entry of a capped type dropped, or it
       * may have written its entries in an earlier flush and only kept dropping since. The counts
       * sit on the context until someone reports them, and returning first is how they were lost.
       */
      this.#reportTruncation(context, drained)

      if (drained.length === 0) {
        if (!context.sampled && context.retention === 'pending') {
          context.retention = 'dropped'
        }

        return
      }

      if (!context.sampled) {
        if (context.retention === 'dropped') {
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

            /**
             * Captured-context watchers may record while the monitored-tag read is in flight.
             * Fold those entries into the same final decision so a late monitored tag or
             * keepAlways match retains the complete batch rather than being cleared as a drop.
             */
            drained.push(...context.buffer.splice(0))
            this.#reportTruncation(context, drained)

            if (drained.length !== entriesBeforeRefresh) {
              kept =
                safeguard(
                  'periscope.recorder.keep_always',
                  () => this.#config.recording.keepAlways(batchView),
                  false
                ) === true
            }

            kept ||=
              monitoredTags === null ||
              batchView.hasEntryWhere((entry) => entry.tags.some((tag) => monitoredTags.has(tag)))
          }

          context.retention = kept ? 'kept' : 'dropped'

          if (!kept) {
            /**
             * A listener may record another fragment while the monitored-tag read is in flight.
             * The final decision owns the context, so a drop must clear those arrivals too.
             */
            context.buffer.splice(0)
            return
          }
        }
      }

      const stored = drained.map((entry) => entry.toStored(this.#config.applicationName))

      /**
       * §0, invariant 2. The driver's own work — a Lucid insert, its query log, whatever it
       * writes to stderr — is observable by the very watchers feeding this recorder. Muting the
       * write is what stops a flush from generating the entries for the next flush.
       */
      await BatchScope.mute(() => this.store.save(stored))

      for (const entry of stored) {
        this.#notifyFlushed(entry)
      }

      this.#flushesSinceTrim++

      if (this.#flushesSinceTrim < TRIM_EVERY_FLUSHES) {
        return
      }

      /**
       * Reset *before* the trim rather than after it resolves, so the interval counts attempts
       * and not successes. A store whose deletes fail — a locked SQLite file, a read-only
       * replica, a permissions problem — would otherwise sit pinned at the threshold and turn
       * every single subsequent flush into another failed maintenance query against a database
       * that is already unhealthy. Skipping one interval's worth of trimming costs nothing in
       * exchange: the cap bounds history, not correctness, and whenever the store recovers a
       * single trim collapses the whole accumulated backlog in one statement.
       */
      this.#flushesSinceTrim = 0

      /**
       * Muted for exactly the reason the save above is (§0, invariant 2): a trim is a delete,
       * which is database traffic the query watcher would hand straight back to this recorder.
       * It also shares the enclosing `safeguardAsync`, so a driver that cannot trim degrades
       * into "history grows past the cap" instead of into a rejected flush — pruning is
       * housekeeping, and housekeeping must never be able to fail a request.
       *
       * Against the `memory` driver this is close to free. That store already evicts the oldest
       * entries on every save, so it is under the cap by construction and its `trim` returns 0
       * after a single size comparison; the call stays unconditional because the recorder does
       * not know, and must not care, which driver it was handed.
       */
      await BatchScope.mute(() => this.store.trim(this.#config.storage.maxEntries))
    })
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
        await this.#ambient.stop()
      })
    }

    await this.#shuttingDown
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
   * `Redactor#redact` returns its argument by identity when there is nothing to scrub, so
   * `entry.content` is very often the exact object the watcher was handed by the host
   * application, which may still be holding it. Periscope observes; it does not add keys to
   * things it was merely shown.
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
