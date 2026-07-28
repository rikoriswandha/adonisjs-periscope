/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The ordering stamp put on every entry the recorder accepts.
 *
 * `sequence` is the primary sort key for the whole dashboard, so it has to be three things at
 * once, and no single clock gives all three:
 *
 * - **Meaningful across processes and restarts.** `process.hrtime.bigint()` counts from an
 *   arbitrary origin — usually boot — so two runs of the same app produce overlapping,
 *   incomparable values. Unusable on its own.
 * - **Fine-grained enough not to tie within one process.** `Date.now()` is millisecond
 *   resolution. A request that fires forty queries would otherwise tie forty times.
 * - **Monotonic.** Wall-clock time goes backwards: NTP steps, VM snapshot restores, a manual
 *   `date -s`. An entry recorded after another must never sort before it.
 *
 * The combination used here is the standard one: anchor the monotonic clock to the wall clock
 * *once*, at module load, and derive every later reading from that anchor.
 *
 * ```
 * EPOCH_ORIGIN_NS = Date.now() in ns - hrtime()      // wall-clock value of hrtime's origin
 * sequence        = EPOCH_ORIGIN_NS + hrtime()       // ns since the Unix epoch, monotonic
 * ```
 *
 * The result reads as nanoseconds since the Unix epoch — comparable with values from other
 * processes and meaningful to a human — while every increment inside this process comes from the
 * monotonic clock. Separate processes can still tie; durable stores order and page by the
 * collision-safe `(sequence, uuid)` pair, using the entry UUID as the final tie-breaker.
 */

/**
 * Wall-clock value, in nanoseconds since the Unix epoch, of the instant `process.hrtime.bigint()`
 * counts from. Captured once: re-deriving it per call would import every wall-clock correction
 * back into the sequence and destroy monotonicity, which is the entire point of the anchor.
 */
const EPOCH_ORIGIN_NS = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint()

/**
 * Last value handed out, so consecutive calls can be forced apart. `hrtime.bigint()` is
 * *nanosecond-denominated*, not nanosecond-precise: on platforms with a coarser underlying timer
 * two calls in a tight loop can return the same reading.
 */
let last = 0n

/**
 * The next ordering stamp: nanoseconds since the Unix epoch, strictly increasing within this
 * process.
 *
 * Two entries recorded in the same clock tick are separated by handing the second one
 * `last + 1n`. That borrows from the future by a nanosecond at a time, which is harmless — the
 * clock catches up on the next tick, and the guarantee callers actually rely on is the ordering,
 * not the last digits of the timestamp.
 *
 * Maintainer note: this function looks like it could be shortened to `Date.now() * 1_000_000n` or
 * to a bare `process.hrtime.bigint()`. Both are bugs. See the module JSDoc above.
 */
export function nextSequence(): bigint {
  const value = EPOCH_ORIGIN_NS + process.hrtime.bigint()

  last = value > last ? value : last + 1n

  return last
}
