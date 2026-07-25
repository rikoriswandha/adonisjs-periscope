/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { performance } from 'node:perf_hooks'

import { IncomingEntry } from '../entry.ts'
import { safeguard, safeguardAsync } from '../safeguard.ts'
import { EntryType, Flag } from '../types.ts'
import type {
  BatchContext,
  BatchKind,
  FilterHook,
  PeriscopeStore,
  ResolvedPeriscopeConfig,
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

  readonly #config: ResolvedPeriscopeConfig
  readonly #enabled: boolean
  readonly #redactor: Redactor
  readonly #ambient: AmbientBatch

  /**
   * Hooks registered at runtime through {@link Recorder.filter} and {@link Recorder.tag}, kept
   * apart from the configured ones so that unregistering cannot mutate the user's config array.
   * Configured hooks always run first.
   */
  readonly #filterHooks: FilterHook[] = []
  readonly #tagHooks: TagHook[] = []

  /**
   * Cached value of the `paused` flag, plus when it was last refreshed. See
   * {@link Recorder.paused}.
   *
   * The stamp is `performance.now()`, not `Date.now()`: it is a TTL, never a timestamp, and
   * nothing persists or displays it. A wall clock can step backwards — an NTP correction, a
   * container resuming with a synchronised clock — and `now - #pausedReadAt` would then go
   * negative, freezing the cached flag for the whole length of the step. `NEGATIVE_INFINITY`
   * seeds it because `performance.now()` starts near zero, so a plain `0` would make the first
   * read of a freshly booted process look fresh and skip the initial refresh.
   */
  #paused = false
  #pausedReadAt = Number.NEGATIVE_INFINITY

  /**
   * Memoised shutdown, which is what makes {@link Recorder.shutdown} idempotent: a second caller
   * awaits the first stop instead of starting another one.
   */
  #shuttingDown: Promise<void> | null = null

  constructor(options: RecorderOptions) {
    this.store = options.store
    this.#config = options.config
    this.#enabled = options.enabled ?? options.config.enabled
    this.#redactor = new Redactor(options.config.redact)
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
   * per entry would be absurd. So this is a cached read with the TTL from
   * `recording.pausedFlagTtlMs` (5 s by default): the getter returns the last known value
   * *immediately* and, when the cache has aged out, kicks off a fire-and-forget refresh whose
   * result lands in time for the next reader.
   *
   * The staleness window is deliberate and harmless: pausing is a human action, and a handful of
   * extra entries in the seconds after the command is not worth blocking every watcher on I/O.
   *
   * A store that throws leaves the previous value in place. Failing closed — treating an
   * unreachable store as "paused" — would silently stop recording exactly when something is
   * already wrong and the entries matter most.
   */
  get paused(): boolean {
    const now = performance.now()

    if (now - this.#pausedReadAt >= this.#config.recording.pausedFlagTtlMs) {
      /**
       * Marked fresh *before* the read resolves, so a burst of entries kicks off one refresh
       * rather than one per entry.
       */
      this.#pausedReadAt = now

      void safeguardAsync('periscope.recorder.paused', async () => {
        /**
         * §0, invariant 2, exactly as in {@link Recorder.flush}: this is a store read like any
         * other, and the driver's own query and log traffic is observable by the watchers feeding
         * this recorder. Worse than the flush case, the refresh is kicked off from inside
         * `record()`, so an unmuted read would attribute Periscope's own bookkeeping to whichever
         * host request happened to trip the TTL.
         */
        this.#paused = (await BatchScope.mute(() => this.store.getFlag(Flag.PAUSED))) !== null
      })
    }

    return this.#paused
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

      entry.content = this.#redactor.redact(entry.content)

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
   * Persist everything buffered in `target`, defaulting to the active batch.
   *
   * Never rejects: the request middleware awaits this on the way out of every request, and a
   * broken store must not turn into a 500.
   */
  async flush(target?: BatchContext): Promise<void> {
    await safeguardAsync('periscope.recorder.flush', async () => {
      const context = target ?? BatchScope.current() ?? this.#ambient.current()

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
        return
      }

      const stored = drained.map((entry) => entry.toStored())

      /**
       * §0, invariant 2. The driver's own work — a Lucid insert, its query log, whatever it
       * writes to stderr — is observable by the very watchers feeding this recorder. Muting the
       * write is what stops a flush from generating the entries for the next flush.
       */
      await BatchScope.mute(() => this.store.save(stored))
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
   * Start the rotating ambient batch, which drains everything recorded outside a request,
   * command, queue job or test.
   *
   * A disabled recorder never buffers anything, so it arms no timer at all. That keeps the
   * "Periscope off costs nothing" promise literal rather than approximate.
   */
  start(): void {
    if (!this.#enabled) {
      return
    }

    /**
     * Starting again makes the previous shutdown history. Without this, the memo in
     * {@link Recorder.shutdown} would still hold the resolved promise of the *first* stop, and a
     * second `shutdown()` would resolve instantly against it while the timer armed just below
     * kept rotating. {@link AmbientBatch} is restartable, so the recorder around it must be too.
     */
    this.#shuttingDown = null

    this.#ambient.start()
  }

  /**
   * Stop the ambient batch — which performs its own final flush — and do nothing else.
   *
   * The store is intentionally left open: the provider owns it, and other subsystems (the
   * pruning scheduler, an in-flight dashboard request) may still be reading through it while the
   * recorder winds down. Calling this twice is safe.
   */
  async shutdown(): Promise<void> {
    this.#shuttingDown ??= safeguardAsync('periscope.recorder.shutdown', () => this.#ambient.stop())
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
