/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { clearInterval, setInterval } from 'node:timers'

import { safeguardAsync } from '../safeguard.ts'
import type { BatchContext } from '../types.ts'
import { BatchScope } from './context.ts'

/**
 * Label used for every failure this module swallows, so `PERISCOPE_DEBUG` output points at the
 * ambient timer rather than at the recorder that owns the flush callback.
 */
const SAFEGUARD_LABEL = 'periscope.ambient'

export type AmbientBatchOptions = {
  /**
   * How long a single ambient batch stays open. Defaults to `10_000` in the resolved config.
   */
  rotationMs: number

  /**
   * Hands a retired context off to be persisted. Supplied by the recorder, which maps the
   * buffer to `StoredEntry[]` and writes it to the store.
   */
  flush: (context: BatchContext) => void | Promise<void>
}

/**
 * The batch of last resort (plan P1.2).
 *
 * A watcher can fire at any moment — a scheduled job logs, a cache warms on boot, an unhandled
 * rejection surfaces between requests. None of that sits inside a `BatchScope.run`, so
 * `BatchScope.current()` is `undefined` and there is no natural boundary to flush on.
 *
 * Rather than give each such entry its own one-entry batch, they all accumulate in a single
 * ambient context that a timer retires every `rotationMs`. The dashboard then shows coherent
 * "what happened between 10:00:00 and 10:00:10" batches, and the store sees batched writes
 * instead of one round-trip per entry.
 */
export class AmbientBatch {
  readonly #options: AmbientBatchOptions

  /**
   * The context every ambient entry is currently landing in. Never null: created eagerly so a
   * watcher that fires before `start()` (during provider boot, say) still has somewhere to go.
   */
  #context: BatchContext

  /**
   * The rotation timer, or `null` when not armed. Doubles as the `running` flag — one piece of
   * state cannot disagree with itself.
   */
  #timer: NodeJS.Timeout | null = null

  /**
   * The rotation currently swapping or flushing, or `null` when none is running.
   *
   * A rotation is not instantaneous: the flush it awaits is a sqlite transaction or a Lucid
   * insert, not a synchronous array push. Without a handle on it, `stop()` cannot observe a
   * rotation the timer already started, and the provider's shutdown hook closes the store the
   * moment `stop()` resolves — tearing the connection out from under a live write. Holding the
   * promise is what turns "stopped" into a guarantee that every buffered entry has been handed
   * to `flush` and that `flush` has settled.
   *
   * It doubles as the serialisation point for {@link AmbientBatch.rotate}: each rotation chains
   * onto the one before it, so a flush slower than `rotationMs` cannot have the next rotation
   * swap the context out from under it.
   */
  #inFlight: Promise<void> | null = null

  constructor(options: AmbientBatchOptions) {
    this.#options = options
    this.#context = BatchScope.createContext('ambient')
  }

  /**
   * Whether the rotation timer is armed.
   */
  get running(): boolean {
    return this.#timer !== null
  }

  /**
   * The context ambient entries must be recorded into right now.
   *
   * Read it per entry, never cache it: {@link AmbientBatch.rotate} swaps the reference out from
   * under callers, and a stale reference would push entries into a context that has already been
   * flushed and will never be flushed again.
   */
  current(): BatchContext {
    return this.#context
  }

  /**
   * Arm the rotation timer. Calling it on an already-running instance does nothing, so a
   * provider that boots twice (tests do) cannot end up with two timers racing to rotate.
   *
   * The timer is `unref`ed: an idle Node process must be free to exit, and Periscope observing an
   * application is never a reason to keep it alive. The consequence is that a process exiting
   * cleanly will not fire a last rotation — `stop()` is what guarantees the final flush.
   *
   * The callback is wrapped in `safeguardAsync` because nothing awaits it. A `flush` that rejects
   * would otherwise become an unhandled rejection and, under Node's default policy, take the host
   * application down (plan §0, invariant 1).
   */
  start(): void {
    if (this.#timer !== null) {
      return
    }

    const timer = setInterval(() => {
      void safeguardAsync(SAFEGUARD_LABEL, () => this.rotate())
    }, this.#options.rotationMs)

    timer.unref()
    this.#timer = timer
  }

  /**
   * Retire the open context and install a fresh one.
   *
   * The swap happens *before* the flush is awaited, and that ordering is the whole point: a flush
   * is asynchronous and entries keep arriving while it runs. If the swap came after, those
   * entries would append to the buffer being persisted and would either be written twice — once
   * by this flush, once by the next — or be dropped when the flushed buffer was cleared. Swapping
   * first makes the retired buffer immutable in practice: `current()` no longer returns it, so
   * nothing can push into it.
   *
   * An empty retired context is dropped on the floor instead of flushed. On an idle process the
   * timer fires every `rotationMs` forever, and there is no reason for that to reach storage.
   *
   * Rotations never overlap. A second call — the timer firing again while a flush is slow, or a
   * `stop()` landing mid-rotation — waits for the running one to settle before performing its
   * own swap. Overlapping swaps would retire a context the previous rotation had only just
   * installed, so entries recorded during a slow flush could be handed to `flush` in an order
   * the store never sees as coherent, and the buffer of the second batch could still be growing
   * while the first flush drains it.
   */
  async rotate(): Promise<void> {
    const rotation = this.#rotate(this.#inFlight)

    this.#inFlight = rotation

    try {
      await rotation
    } finally {
      // Only the rotation that is still the latest one may clear the field: a rotation queued
      // behind this one has already claimed it, and nulling it here would let a third rotation
      // start its swap in parallel with the second one's flush.
      if (this.#inFlight === rotation) {
        this.#inFlight = null
      }
    }
  }

  /**
   * One rotation, queued behind `previous`.
   *
   * Split out of {@link AmbientBatch.rotate} so the public method can publish the promise for
   * this whole sequence — queue wait included — before anything is awaited. A caller that gets
   * the promise only once the swap had happened would leave a window in which `stop()` sees no
   * in-flight rotation while one is very much in flight.
   */
  async #rotate(previous: Promise<void> | null): Promise<void> {
    if (previous !== null) {
      // A predecessor's failure is not this rotation's to surface: the timer callback or the
      // direct caller that started it already owns that rejection. We only need it settled.
      await previous.catch(() => {})
    }

    const retired = this.#context
    this.#context = BatchScope.createContext('ambient')

    if (retired.buffer.length === 0) {
      return
    }

    await this.#options.flush(retired)
  }

  /**
   * Disarm the timer and flush whatever is still buffered.
   *
   * Called from the provider's shutdown hook, which closes the store as soon as this resolves.
   * So resolving means everything is on disk, and that takes two waits: a rotation the timer
   * started may still be flushing, and whatever accumulated since — including entries recorded
   * *during* that flush — still has to be retired. The timer is cleared and forgotten first, so
   * no third rotation can be armed behind them.
   *
   * Awaiting the in-flight rotation explicitly, rather than leaning on `rotate()` queueing
   * behind it, keeps the guarantee local to `stop()`: shutdown is the one path where "everything
   * has settled" must hold regardless of how rotations are serialised internally.
   *
   * The method is idempotent and safe on an instance that was never started, because shutdown
   * paths run in unpredictable combinations and a failed boot must still be able to tear down.
   *
   * Failures are swallowed here for the same reason as in the timer: shutdown is not a place to
   * throw, and a store that is already gone is the most likely cause.
   */
  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }

    const pending = this.#inFlight

    if (pending !== null) {
      // Reported by whoever started it, if it fails; here it only has to be over.
      await pending.catch(() => {})
    }

    await safeguardAsync(SAFEGUARD_LABEL, () => this.rotate())
  }
}
