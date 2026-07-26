/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import type { BatchContext } from '../types.ts'

/**
 * The batch a request opened, reachable from its {@link HttpContext}.
 *
 * This map is not a fallback — it is the mechanism, and the reason is a detail of how AdonisJS
 * finishes a request. `http:request_completed` is emitted from an `on-finished` callback on the
 * raw Node response, registered *before* the server enters its own `AsyncLocalStorage` scope and
 * fired from the socket's completion callback. That callback therefore runs in an async context
 * that never contained the middleware stack, so `BatchScope.current()` is `undefined` inside the
 * listener — verified in `@adonisjs/http-server`, where `HttpContext.get()` is likewise `null`
 * there. The same is true of `ExceptionHandler.report()`, which the server invokes from the
 * middleware runner's error handler, outside the scope the middleware opened.
 *
 * Both of those *do* get handed the `HttpContext`. So the middleware, which is inside the scope,
 * parks the batch here on the way in, and everything that runs after the scope has unwound looks
 * it up by context object.
 *
 * A `WeakMap` because the key is the request: when a context is collected, so is its batch, and
 * a request whose completion event never fires (a malformed URL rejected before routing, a
 * server torn down mid-flight) leaks nothing.
 */
export type RequestBatch = {
  context: BatchContext

  /**
   * `process.memoryUsage().heapUsed` at the moment the batch opened, for the request entry's
   * memory delta. Sampled in the middleware rather than in the listener because the delta is
   * meant to describe the request's own work.
   */
  startedHeapUsed: number
}

const batches = new WeakMap<HttpContext, RequestBatch>()

/**
 * Park a batch on a request context. Called once, by the request middleware.
 */
export function attachRequestBatch(ctx: HttpContext, batch: RequestBatch): void {
  batches.set(ctx, batch)
}

/**
 * The batch a request opened, or `undefined` when the middleware skipped it — Periscope
 * disabled, the request watcher off, or a dashboard request Periscope refuses to record.
 */
export function findRequestBatch(ctx: HttpContext): RequestBatch | undefined {
  return batches.get(ctx)
}

/**
 * Take the batch off the context and return it.
 *
 * Used by the completion listener, which is the last reader: dropping the entry immediately
 * makes a second completion event for the same context a no-op instead of a double flush.
 */
export function takeRequestBatch(ctx: HttpContext): RequestBatch | undefined {
  const batch = batches.get(ctx)

  if (batch !== undefined) {
    batches.delete(ctx)
  }

  return batch
}

/**
 * Requests Periscope has decided not to record at all — today, exactly the dashboard's own
 * traffic (§0, invariant 2: browsing recordings must not create recordings).
 *
 * "No batch" and "no recording" are different facts and both have to be representable. A request
 * with no batch may simply have missed the middleware, in which case the honest fallback is the
 * ambient batch; a request that was *refused* must produce nothing anywhere, including from the
 * code paths that run outside the middleware's scope and therefore outside its mute — the
 * exception reporter above all, which the server calls with the context and nothing else.
 *
 * A separate `WeakSet` rather than a flag on {@link RequestBatch} because the two answers have
 * different lifetimes: the batch is taken by the completion listener, while the refusal must
 * survive until the context itself is collected.
 */
const ignored = new WeakSet<HttpContext>()

/**
 * Refuse a request. Called by the request middleware before it hands control downstream.
 */
export function markIgnoredRequest(ctx: HttpContext): void {
  ignored.add(ctx)
}

/**
 * Whether this request was refused. Watchers that can be reached outside the request's async
 * scope must consult it before recording anything attributed to a context.
 */
export function isIgnoredRequest(ctx: HttpContext): boolean {
  return ignored.has(ctx)
}
