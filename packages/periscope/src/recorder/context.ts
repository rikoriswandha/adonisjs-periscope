/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import type { BatchContext, BatchKind } from '../types.ts'
import { activeTraceId } from './trace_context.ts'

/**
 * The one and only batch store (plan P1.2).
 *
 * It is module-level rather than a static class property so that every importer of this module
 * shares the same storage instance: correlation breaks the moment two copies of the store exist,
 * and a `static storage` field is far easier to accidentally re-assign or subclass away.
 *
 * `AsyncLocalStorage` is what makes correlation free for watchers. A watcher deep inside a query
 * driver never receives the request it belongs to; it simply asks {@link BatchScope.current} and
 * gets the context of whichever request, command, queue job or test is on the current async
 * stack — through `await`s, microtasks, timers and event-emitter callbacks alike.
 */
const storage = new AsyncLocalStorage<BatchContext>()

/**
 * Sampling is process-wide for the same reason the async batch store is: an application has one
 * recorder singleton, while the request and command boundaries create contexts without carrying
 * that singleton through every watcher.
 */
let sampleRate = 1

/**
 * Entry point to the active batch.
 *
 * Everything Periscope records is attributed to exactly one {@link BatchContext}. Scopes are
 * opened by the things that bound a unit of work — the HTTP middleware, the command hook, the
 * queue worker, the test hooks — and everything recorded outside one of them belongs to the
 * rotating ambient batch instead (see `./ambient.ts`).
 *
 * The class is a namespace of statics on purpose: watchers must be able to reach the current
 * batch from anywhere without being handed a dependency. The recorder configures its one
 * process-wide sampling rate at construction.
 */
export class BatchScope {
  /**
   * Install the resolved sampling rate used by every subsequent context creation path.
   */
  static configureSampling(rate: number): void {
    sampleRate = rate
  }

  /**
   * Build a fresh, empty batch of `kind`.
   *
   * Exposed rather than kept private because the ambient batch has to mint contexts it then
   * installs itself, without ever entering the async store.
   *
   * `startedAt` is `process.hrtime.bigint()`: a monotonic reading immune to wall-clock jumps,
   * used to measure how long the batch stayed open. It is deliberately *not* an ordering key
   * across processes — `StoredEntry.sequence` owns ordering.
   */
  static createContext(kind: BatchKind): BatchContext {
    const traceId = activeTraceId()
    return {
      batchId: randomUUID(),
      kind,
      startedAt: process.hrtime.bigint(),
      ...(traceId === undefined ? {} : { traceId }),
      sampled: sampleRate >= 1 || (sampleRate > 0 && Math.random() < sampleRate),
      retention: 'pending',
      buffer: [],
      counters: {},
      truncated: {},
      muted: false,
    }
  }

  /**
   * Open a new batch of `kind` and run `fn` inside it.
   *
   * The value of `fn` is returned untouched, so an async `fn` hands back its promise and the
   * context stays current across every `await` in it.
   */
  static run<T>(kind: BatchKind, fn: () => T): T {
    return storage.run(BatchScope.createContext(kind), fn)
  }

  /**
   * Run `fn` inside an *existing* context.
   *
   * Needed whenever a batch outlives the callback that opened it: the ambient batch re-enters its
   * current context for a single `record()` call, and the recorder re-enters a retired context to
   * flush it.
   */
  static runWith<T>(context: BatchContext, fn: () => T): T {
    return storage.run(context, fn)
  }

  /**
   * The batch on the current async stack, or `undefined` when nothing opened one.
   *
   * A watcher seeing `undefined` must fall back to the ambient batch rather than invent a
   * context of its own, otherwise every ambient entry becomes its own singleton batch.
   */
  static current(): BatchContext | undefined {
    return storage.getStore()
  }

  /**
   * Run `fn` with recording suppressed (plan §0, invariant 2: "Periscope never records itself").
   *
   * The recorder wraps its own `store.save()` in this, so a storage driver that issues SQL — the
   * `database` driver does exactly that — cannot make the query watcher record the write that is
   * persisting the previous entries, which would recurse without bound.
   *
   * Muting installs a *child* context rather than mutating the outer one. That matters twice
   * over:
   *
   * - The mute is scoped. Whatever the caller does concurrently keeps recording, and the outer
   *   context is guaranteed to come back unmuted even if `fn` throws.
   * - The child gets its own `buffer`, `counters` and `truncated`. Aliasing the outer collections
   *   would let a dropped-but-still-counted entry consume the host batch's caps, and would let a
   *   flush in progress see entries appended behind its back.
   *
   * The child keeps the outer `batchId` and `kind` so that anything Periscope logs about itself
   * still correlates with the batch that triggered it. With no outer context there is nothing to
   * correlate with, so a throwaway `ambient` context is used.
   */
  static mute<T>(fn: () => T): T {
    const outer = storage.getStore()
    const muted: BatchContext = outer
      ? { ...outer, buffer: [], counters: {}, truncated: {}, muted: true }
      : { ...BatchScope.createContext('ambient'), muted: true }

    return storage.run(muted, fn)
  }
}
