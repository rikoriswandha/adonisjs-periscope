/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import { IncomingEntry } from '../../entry.ts'
import { BatchScope } from '../../recorder/context.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import { getActiveWatcher, setActiveWatcher } from '../active.ts'
import type { WatcherContext } from '../context.ts'
import { familyHash } from '../hash.ts'
import { findRequestBatch, isIgnoredRequest } from '../http_batch.ts'
import {
  installProcessObservers,
  uninstallProcessObservers,
  type ProcessObserverOptions,
} from './process.ts'
import { codeFrame, parseStack } from './stack.ts'
import type { ExceptionEntryContent, ExceptionRequestSummary } from './types.ts'

type CapturedExceptionContent = ExceptionEntryContent & {
  origin?: NodeJS.UncaughtExceptionOrigin
}

/**
 * The raw stack is valuable when parsing misses an unusual frame, but it is still
 * application-controlled input. A 64 KiB ceiling leaves ample room for diagnostics while
 * preventing a custom `Error.prepareStackTrace` from placing an unbounded string in one entry.
 * The marker is included inside that ceiling so the storage bound remains literal.
 */
const MAX_STACK_BYTES = 64 * 1024
const STACK_TRUNCATION_MARKER = '\n[Periscope truncated this stack at the 64 KiB storage limit.]'

function boundedStack(stack: string): string {
  if (Buffer.byteLength(stack, 'utf8') <= MAX_STACK_BYTES) {
    return stack
  }

  const prefixBytes = MAX_STACK_BYTES - Buffer.byteLength(STACK_TRUNCATION_MARKER, 'utf8')
  let prefix = Buffer.from(stack, 'utf8').subarray(0, prefixBytes).toString('utf8')

  /**
   * Decoding a byte slice that ends within a multi-byte character emits a replacement character,
   * which can itself exceed the remaining byte budget. Removing complete trailing characters
   * keeps the final string valid UTF-8 without weakening the documented ceiling.
   */
  while (Buffer.byteLength(prefix, 'utf8') > prefixBytes) {
    prefix = prefix.slice(0, -1)
  }

  return `${prefix}${STACK_TRUNCATION_MARKER}`
}

/**
 * Read an application-owned property without trusting its getter. Exception objects are commonly
 * decorated by libraries, and a proxy or throwing getter on the error path must not prevent the
 * useful standard fields from being captured.
 */
function readProperty(value: unknown, key: PropertyKey): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined
  }

  try {
    return (value as Record<PropertyKey, unknown>)[key]
  } catch {
    return undefined
  }
}

function exceptionName(error: unknown): string {
  const constructor = readProperty(error, 'constructor')
  const constructorName = readProperty(constructor, 'name')

  if (typeof constructorName === 'string' && constructorName.length > 0) {
    return constructorName
  }

  if (error === null) {
    return 'Null'
  }

  if (error === undefined) {
    return 'Undefined'
  }

  const kind = typeof error
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
}

/**
 * Preserve a real message when one exists. A plain thrown object still needs a useful headline,
 * so its bounded serialised form becomes the message rather than JavaScript's opaque
 * `[object Object]`.
 */
function exceptionMessage(error: unknown): string {
  const message = readProperty(error, 'message')
  if (typeof message === 'string' && message.length > 0) {
    return message
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    return JSON.stringify(safeSerialize(error)) ?? String(error)
  } catch {
    return String(error)
  }
}

/**
 * The request summary deliberately reads only stable routing facts. Bodies, headers and params
 * belong to the request entry, where their own size limits and redaction rules apply; copying
 * them onto every exception would both duplicate secrets and inflate the batch.
 */
function requestSummary(ctx: HttpContext): ExceptionRequestSummary {
  let method = 'UNKNOWN'
  let url = ''

  try {
    method = ctx.request.method()
  } catch {
    /** A partially constructed context can still contribute the remaining request facts. */
  }

  try {
    url = ctx.request.url(true)
  } catch {
    /** See the method read above: request context failures are isolated field by field. */
  }

  const summary: ExceptionRequestSummary = { method, url }

  try {
    if (ctx.route !== undefined) {
      summary.route = {
        pattern: ctx.route.pattern,
        ...(ctx.route.name !== undefined ? { name: ctx.route.name } : {}),
      }
    }
  } catch {
    /** Route metadata may be absent on 404s and must never make reporting fail. */
  }

  return summary
}

/**
 * Build the complete immutable observation before handing it to the recorder. AdonisJS's
 * `ExceptionHandler.toHttpError()` mutates object throws by assigning `message` and `status`; the
 * mixin records first by contract, so this function faithfully captures whichever state exists
 * at that exact call rather than trying to normalise or reverse upstream's mutation.
 */
function exceptionContent(
  error: unknown,
  ctx: HttpContext | undefined,
  captureCodeFrame: boolean,
  origin?: NodeJS.UncaughtExceptionOrigin
): { content: CapturedExceptionContent; topAppFrame: string | undefined } {
  const name = exceptionName(error)
  const message = exceptionMessage(error)
  const rawStack = readProperty(error, 'stack')
  const stack = typeof rawStack === 'string' ? boundedStack(rawStack) : ''
  const frames = parseStack(stack)
  const top = frames.find((frame) => frame.type === 'app')
  const code = readProperty(error, 'code')
  const status = readProperty(error, 'status')
  const explicitContext = readProperty(error, 'context')

  const content: CapturedExceptionContent = {
    name,
    message,
    stack,
    frames,
    ...(origin === undefined ? {} : { origin }),
  }

  if (typeof code === 'string' || typeof code === 'number') {
    content.code = String(code)
  }

  if (typeof status === 'number' && Number.isFinite(status)) {
    content.status = status
  }

  if (captureCodeFrame && top !== undefined) {
    const source = codeFrame(top)
    if (source !== undefined) {
      content.codeFrame = source
    }
  }

  if (ctx !== undefined) {
    content.request = requestSummary(ctx)
  }

  if (explicitContext !== undefined) {
    content.context = safeSerialize(explicitContext)
  } else if (!(error instanceof Error)) {
    content.context = safeSerialize(error)
  }

  return {
    content,
    topAppFrame:
      top === undefined ? undefined : `${top.file}:${top.line ?? ''}:${top.column ?? ''}`,
  }
}

/**
 * Captures exceptions reported by the application's handler and process-level failures that have
 * no HTTP context. The public `report` method is deliberately synchronous: it lives on the
 * application's own error path, where awaiting storage would delay or replace core's reporter.
 */
export class ExceptionWatcher implements Watcher {
  readonly name = WatcherName.EXCEPTION

  readonly #context: WatcherContext
  readonly #processOptions: ProcessObserverOptions
  #registered = false

  constructor(context: WatcherContext) {
    this.#context = context
    this.#processOptions = {
      recorder: context.recorder,
      report: (error, origin) => this.report(error, undefined, origin),
    }
  }

  register(): void {
    if (this.#registered) {
      return
    }

    this.#registered = true
    setActiveWatcher('exception', this)

    if (this.#context.config.watchers.exception.captureProcessErrors) {
      installProcessObservers(this.#processOptions)
    }
  }

  cleanup(): void {
    if (this.#registered) {
      this.#registered = false
      uninstallProcessObservers(this.#processOptions)
    }

    if (getActiveWatcher('exception') === this) {
      setActiveWatcher('exception', null)
    }
  }

  /**
   * Record into the request batch parked on `ctx`, or let the recorder select the current/ambient
   * batch when there is no request. `ExceptionHandler.report()` runs outside the middleware's ALS
   * scope, so merely calling `record()` when a context is supplied would split one failed request
   * into two unrelated batches. The WeakMap lookup re-enters the existing batch without taking it
   * away from the request completion listener that still owns the one and only flush.
   *
   * A missing batch does not by itself mean the request was refused: middleware can be absent
   * while exception capture remains enabled, in which case the ambient fallback is intentional.
   * Dashboard traffic is a distinct refusal recorded by `isIgnoredRequest`, and checking it first
   * prevents an error page (including the dashboard's own 404) from recording itself.
   */
  report(error: unknown, ctx?: HttpContext, origin?: NodeJS.UncaughtExceptionOrigin): void {
    safeguard('periscope.exception.report', () => {
      if (ctx !== undefined && isIgnoredRequest(ctx)) {
        return
      }

      const captureCodeFrame =
        this.#context.config.watchers.exception.captureCodeFrame === 'always' ||
        (this.#context.config.watchers.exception.captureCodeFrame === 'dev' && this.#context.dev)
      const { content, topAppFrame } = exceptionContent(error, ctx, captureCodeFrame, origin)
      const record = () => {
        this.#context.recorder.record(
          IncomingEntry.make(EntryType.EXCEPTION, content)
            .withFamilyHash(familyHash(content.name, content.message, topAppFrame))
            .withTags(origin === undefined ? undefined : `origin:${origin}`)
        )
      }
      const requestBatch = ctx === undefined ? undefined : findRequestBatch(ctx)

      if (requestBatch === undefined) {
        record()
      } else {
        BatchScope.runWith(requestBatch.context, record)
      }
    })
  }
}
