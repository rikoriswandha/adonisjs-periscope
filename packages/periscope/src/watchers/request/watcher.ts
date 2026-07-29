/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

import { IncomingEntry } from '../../entry.ts'
import { BatchScope } from '../../recorder/context.ts'
import type { Redactor } from '../../recorder/redactor.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard, safeguardAsync } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { BatchContext, Watcher } from '../../types.ts'
import { getActiveWatcher, setActiveWatcher } from '../active.ts'
import type { WatcherContext } from '../context.ts'
import {
  attachRequestBatch,
  findRequestBatch,
  markIgnoredRequest,
  takeRequestBatch,
} from '../http_batch.ts'
import type { RequestEntryContent, RequestAuthSummary, RequestFileMetadata } from './types.ts'

const STRING_TRUNCATION_MARKER = '[Truncated]'
const STATIC_ASSET_PATH =
  /\.(?:js|mjs|css|map|ico|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|eot)$/i
const STATIC_ASSET_CONTENT_TYPES = [
  'text/css',
  'image/',
  'font/',
  'application/javascript',
  'text/javascript',
]

type RequestKind = 'document' | 'inertia' | 'xhr' | 'asset'

/**
 * Keep classification and ignore matching on the pathname even when a request double or an
 * upstream adapter includes the query string in `request.url()`.
 */
function requestPath(url: string): string {
  const queryStart = url.indexOf('?')
  const fragmentStart = url.indexOf('#')
  const pathEnd =
    queryStart === -1
      ? fragmentStart
      : fragmentStart === -1
        ? queryStart
        : Math.min(queryStart, fragmentStart)

  return pathEnd === -1 ? url : url.slice(0, pathEnd)
}

/**
 * Compile the event watcher's deliberately small glob language for request paths. Splitting on
 * `*` before escaping keeps every regular-expression metacharacter as application data, and
 * anchoring ensures `/assets/*` does not hide `/assets-other`.
 */
function compileGlob(glob: string): RegExp {
  const source = glob
    .split('*')
    .map((fragment) => fragment.replace(/[\\^$.+?()[\]{}|]/g, '\\$&'))
    .join('.*')

  return new RegExp(`^${source}$`)
}

/**
 * Classify by the most specific transport signal first. Inertia may also present as an XHR and
 * assets may be fetched with JSON-oriented headers, so the order is part of the stored contract.
 */
function classifyRequest(ctx: HttpContext, path: string): RequestKind {
  const { request, response } = ctx

  if (request.header('x-inertia') !== undefined) {
    return 'inertia'
  }

  const rawContentType = response.getHeader('content-type')
  const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType
  const normalizedContentType =
    typeof contentType === 'string' ? contentType.trimStart().toLowerCase() : undefined
  if (
    STATIC_ASSET_PATH.test(path) ||
    (normalizedContentType !== undefined &&
      STATIC_ASSET_CONTENT_TYPES.some((prefix) => normalizedContentType.startsWith(prefix)))
  ) {
    return 'asset'
  }

  const requestedWith = request.header('x-requested-with')
  const firstAcceptedType = request
    .header('accept')
    ?.split(',', 1)[0]
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase()
  if (
    requestedWith?.trim().toLowerCase() === 'xmlhttprequest' ||
    firstAcceptedType === 'application/json'
  ) {
    return 'xhr'
  }

  return 'document'
}

type RequestCompletedPayload = {
  ctx: HttpContext
  duration: [number, number]
}

/**
 * The bodyparser methods are module augmentations supplied by an optional package, so Periscope
 * cannot import their types without turning bodyparser into a dependency. This local shape is the
 * exact runtime contract used here and, critically, includes the private readiness flag that must
 * be checked before `allFiles()` is allowed to run.
 */
type RequestWithFiles = HttpContext['request'] & {
  __raw_files?: Record<string, UploadFileLike | UploadFileLike[]>
  allFiles?: () => Record<string, UploadFileLike | UploadFileLike[]>
}

type UploadFileLike = {
  fieldName: string
  clientName: string
  size: number
  type?: string
  extname?: string
}

/**
 * A dashboard prefix is a path boundary rather than a string prefix. Without the boundary check,
 * mounting the dashboard at `/periscope` would also suppress an unrelated `/periscope-health`
 * endpoint from recordings.
 */
function isDashboardRequest(url: string, dashboardPath: string): boolean {
  return dashboardPath === '/' || url === dashboardPath || url.startsWith(`${dashboardPath}/`)
}

/**
 * Convert Node's high-resolution duration tuple without rounding it. Sub-millisecond precision is
 * useful when a low slow-request threshold is being tuned, and the stored number remains ordinary
 * JSON rather than introducing a bigint into entry content.
 */
function durationInMilliseconds(duration: [number, number]): number {
  return duration[0] * 1_000 + duration[1] / 1_000_000
}

/**
 * Cut a string on a UTF-8 boundary and reserve room for a visible truncation marker. JavaScript
 * string length counts UTF-16 code units, which would let multibyte response text exceed the
 * byte-oriented configuration limit by several times.
 */
function truncateString(value: string, maxBytes: number): string {
  const prefixBudget = Math.max(0, maxBytes - STRING_TRUNCATION_MARKER.length)
  let byteLength = 0
  let prefixEnd = 0

  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)
    if (codePoint === undefined) {
      break
    }

    const codeUnits = codePoint > 0xffff ? 2 : 1
    byteLength += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4

    if (byteLength <= prefixBudget) {
      prefixEnd = index + codeUnits
    }

    if (byteLength > maxBytes) {
      return `${value.slice(0, prefixEnd)}${STRING_TRUNCATION_MARKER}`
    }

    index += codeUnits
  }

  return value
}

/**
 * Reduce a bodyparser file to the fields that describe the upload. Neither `tmpPath` nor any
 * method capable of reading the file crosses this boundary.
 */
function fileMetadata(file: UploadFileLike): RequestFileMetadata {
  return {
    fieldName: file.fieldName,
    clientName: file.clientName,
    size: file.size,
    ...(file.type === undefined ? {} : { type: file.type }),
    ...(file.extname === undefined ? {} : { extname: file.extname }),
  }
}

function serialiseFiles(
  files: Record<string, UploadFileLike | UploadFileLike[]>
): Record<string, RequestFileMetadata | RequestFileMetadata[]> {
  const serialised: Record<string, RequestFileMetadata | RequestFileMetadata[]> = {}

  for (const [field, file] of Object.entries(files)) {
    serialised[field] = Array.isArray(file) ? file.map(fileMetadata) : fileMetadata(file)
  }

  return serialised
}

/**
 * `request.all()` deliberately supplies the application's parsed values, not a copy. Rebuilding
 * the record keeps file metadata replacement and later redaction from mutating the request object
 * that controller code may still retain. The structural cast is the documented boundary to the
 * optional bodyparser augmentation described by {@link RequestWithFiles}.
 */
function requestPayload(ctx: HttpContext, redactor: Redactor): unknown {
  const request = ctx.request as RequestWithFiles
  const values: Record<string, unknown> = { ...request.all() }
  const files =
    request.__raw_files && typeof request.allFiles === 'function'
      ? serialiseFiles(request.allFiles())
      : {}

  return safeSerialize(redactor.redact({ ...values, ...files }))
}

/**
 * Response bodies remain lazy after AdonisJS finishes the socket, which lets the completion event
 * inspect their original value without tapping or consuming the wire. Streams and files are only
 * described, binary data is counted, and application objects go through the bounded serializer.
 */
function responsePreview(ctx: HttpContext, maxBytes: number): unknown {
  const response = ctx.response

  if (response.hasContent) {
    const body: unknown = response.getBody()

    if (typeof body === 'string') {
      return truncateString(body, maxBytes)
    }

    if (ArrayBuffer.isView(body)) {
      return { kind: 'binary', size: body.byteLength }
    }

    if (
      body === null ||
      typeof body === 'object' ||
      typeof body === 'number' ||
      typeof body === 'boolean' ||
      typeof body === 'bigint'
    ) {
      return safeSerialize(body, { maxBytes })
    }

    return undefined
  }

  if (response.hasStream) {
    return { kind: 'stream' }
  }

  if (response.hasFileToStream) {
    const path = response.fileToStream?.path
    return typeof path === 'string' ? { kind: 'file', path } : undefined
  }

  return undefined
}

/**
 * Read only metadata already present in the bounded response preview. A response header is
 * required so an unrelated JSON object with `component` and `props` fields is never mistaken for
 * an Inertia page.
 */
function inertiaSummary(ctx: HttpContext, preview: unknown): RequestEntryContent['inertia'] {
  if (ctx.response.getHeader('x-inertia') === undefined || preview === undefined) {
    return undefined
  }

  const page: unknown =
    typeof preview === 'string'
      ? safeguard('periscope.watcher.request.inertia_json', () => JSON.parse(preview))
      : preview
  if (
    typeof page !== 'object' ||
    page === null ||
    Array.isArray(page) ||
    !('component' in page) ||
    typeof page.component !== 'string'
  ) {
    return undefined
  }

  const props = 'props' in page ? page.props : undefined
  return {
    component: page.component,
    ...(typeof props === 'object' && props !== null && !Array.isArray(props)
      ? { propKeys: Object.keys(props) }
      : {}),
  }
}

/**
 * Session is declared as mandatory by its package even though router middleware is what installs
 * it. A server middleware request, a 404, or an application with sessions disabled therefore has
 * no property at runtime. Both the property and `all()` are checked before reading application
 * values, and a failing session driver costs only this optional snapshot.
 */
function sessionSnapshot(ctx: HttpContext, redactor: Redactor): unknown {
  if (!('session' in ctx)) {
    return undefined
  }

  const session: unknown = ctx.session

  if (
    typeof session !== 'object' ||
    session === null ||
    !('all' in session) ||
    typeof session.all !== 'function'
  ) {
    return undefined
  }

  /**
   * Called as a method, not as a detached function. `Session#all()` reads private state off its
   * own instance, so hoisting the reference and invoking it bare throws inside the session
   * package — silently, because the safeguard below swallows it, which is exactly how a snapshot
   * that is quietly always `undefined` would go unnoticed.
   */
  const readSession = session.all.bind(session)

  return safeguard('periscope.watcher.request.session', () =>
    safeSerialize(redactor.redact(readSession()))
  )
}

/**
 * Authentication is intentionally discovered by shape: core has no `ctx.auth` and Periscope does
 * not depend on an auth provider. A user model is reduced to the two broadly useful scalar fields
 * rather than serialised, preventing relations and provider-specific credentials from leaking
 * into the request entry.
 */
function authSummary(ctx: HttpContext): RequestAuthSummary | undefined {
  if (!('auth' in ctx)) {
    return undefined
  }

  return safeguard('periscope.watcher.request.auth', () => {
    const auth: unknown = ctx.auth

    if (typeof auth !== 'object' || auth === null || !('user' in auth)) {
      return undefined
    }

    const user = auth.user
    if (typeof user !== 'object' || user === null || !('id' in user)) {
      return undefined
    }

    const rawId = user.id
    const id =
      typeof rawId === 'bigint'
        ? rawId.toString()
        : typeof rawId === 'string' || (typeof rawId === 'number' && Number.isFinite(rawId))
          ? rawId
          : undefined
    if (id === undefined) {
      return undefined
    }

    const email = 'email' in user ? user.email : undefined
    return typeof email === 'string' ? { id, email } : { id }
  })
}

/**
 * Build the primary entry only after the request has completed, when AdonisJS has assigned its
 * matched route and final response state. Application-owned payloads are serialised before they
 * reach the recorder; the recorder then performs its normal whole-entry redaction as a second
 * line of defence.
 */
function makeRequestEntry(
  watcherContext: WatcherContext,
  batchContext: BatchContext,
  batchStartedHeapUsed: number,
  payload: RequestCompletedPayload
): { entry: IncomingEntry; routePattern?: string } {
  const { ctx, duration } = payload
  const { request, response } = ctx
  const url = request.url()
  const path = requestPath(url)
  const kind = classifyRequest(ctx, path)
  const durationMs = durationInMilliseconds(duration)
  const clientDisconnected = !response.headersSent && !response.finished
  const status = clientDisconnected ? null : response.getStatus()
  const user = authSummary(ctx)
  const routePattern = ctx.route?.pattern
  const maxResponseBytes = watcherContext.config.watchers.request.responseSizeLimitKb * 1_024
  const preview = watcherContext.config.watchers.request.captureResponse
    ? safeguard('periscope.watcher.request.response', () => responsePreview(ctx, maxResponseBytes))
    : undefined
  const inertia =
    watcherContext.config.watchers.request.captureInertia && preview !== undefined
      ? inertiaSummary(ctx, preview)
      : undefined
  const session = watcherContext.config.watchers.request.captureSession
    ? sessionSnapshot(ctx, watcherContext.recorder.redactor)
    : undefined
  const content: RequestEntryContent = {
    ...(batchContext.traceId === undefined ? {} : { traceId: batchContext.traceId }),
    method: request.method(),
    url,
    query: safeSerialize(request.qs()),
    ...(routePattern === undefined ? {} : { routePattern }),
    ...(ctx.route?.name === undefined ? {} : { routeName: ctx.route.name }),
    headers: watcherContext.recorder.redactor.redactHeaders({ ...request.headers() }),
    payload: requestPayload(ctx, watcherContext.recorder.redactor),
    status,
    durationMs,
    memoryDeltaBytes: process.memoryUsage().heapUsed - batchStartedHeapUsed,
    ip: request.ip(),
    hostname: request.hostname(),
    ...(preview === undefined ? {} : { response: preview }),
    ...(inertia === undefined ? {} : { inertia }),
    ...(session === undefined ? {} : { session }),
    ...(user === undefined ? {} : { user }),
    clientDisconnected,
  }

  const entry = IncomingEntry.make(EntryType.REQUEST, content).withTags(
    status === null ? undefined : `status:${status}`,
    status === null ? undefined : `status:${Math.floor(status / 100)}xx`,
    durationMs >= watcherContext.config.watchers.request.slowMs ? 'slow' : undefined,
    user === undefined ? undefined : `Auth:${user.id}`,
    `method:${content.method}`,
    `kind:${kind}`
  )

  return { entry, routePattern }
}

/**
 * Opens and closes the request batches that every in-request watcher joins. The server middleware
 * opens the scope because it surrounds all downstream work; the completion event closes it
 * because that is the first point with the final route, response and duration.
 */
export class RequestWatcher implements Watcher {
  readonly name = WatcherName.REQUEST

  readonly #context: WatcherContext
  readonly #ignoredPathPatterns: RegExp[]
  #unsubscribe: (() => void) | null = null

  /**
   * Whether the middleware that owns a request context is still running. The socket completion
   * event may arrive first on an aborted request; in that case its flush is intermediate and the
   * middleware performs the final sampling decision after downstream work settles.
   */
  readonly #openContexts = new WeakSet<BatchContext>()

  /**
   * Completion work already in flight for a context taken from the request map. An aborted
   * request can leave the middleware at the same time as the completion listener is building the
   * request entry; awaiting this barrier makes the final straggler flush observe either fragment
   * order as one batch.
   */
  readonly #completionFlushes = new WeakMap<BatchContext, Promise<void>>()
  readonly #pendingCompletions = new Set<Promise<void>>()

  constructor(context: WatcherContext) {
    this.#context = context
    this.#ignoredPathPatterns = context.config.watchers.request.ignorePaths.map(compileGlob)
  }

  register(): void {
    if (this.#unsubscribe === null) {
      this.#unsubscribe = this.#context.emitter.on(
        'http:request_completed',
        (payload: RequestCompletedPayload) => {
          safeguard('periscope.watcher.request.schedule', () => {
            const batch = takeRequestBatch(payload.ctx)
            if (batch === undefined) return

            const intermediate = this.#openContexts.has(batch.context)
            const completion = Promise.withResolvers<void>()
            if (intermediate) {
              this.#completionFlushes.set(batch.context, completion.promise)
            }
            this.#pendingCompletions.add(completion.promise)

            /**
             * Adonis awaits async completion listeners while finalising the response. Recording
             * is observability work, not response work: move it to the check phase so the socket
             * can finish first. The promise is registered synchronously so abort handling and
             * watcher cleanup still wait for every scheduled flush.
             */
            setImmediate(() => {
              void safeguardAsync('periscope.watcher.request.completed', async () => {
                try {
                  const completed = makeRequestEntry(
                    this.#context,
                    batch.context,
                    batch.startedHeapUsed,
                    payload
                  )

                  BatchScope.runWith(batch.context, () => {
                    this.#context.recorder.record(completed.entry)

                    if (completed.routePattern === undefined) return

                    /**
                     * Queries, logs and events happen before the router has returned control to
                     * the server middleware, so the route is unknowable when those entries are
                     * recorded. Stamp everything still buffered at request completion.
                     */
                    for (const entry of batch.context.buffer) {
                      entry.withTags(`route:${completed.routePattern}`)
                    }
                  })
                } finally {
                  await this.#context.recorder.flush(
                    batch.context,
                    intermediate ? 'intermediate' : 'final'
                  )
                }
              }).finally(() => {
                completion.resolve()
                this.#pendingCompletions.delete(completion.promise)
                if (intermediate) {
                  this.#completionFlushes.delete(batch.context)
                }
              })
            })
          })
        }
      )
    }

    setActiveWatcher(WatcherName.REQUEST, this)
  }

  async cleanup(): Promise<void> {
    const unsubscribe = this.#unsubscribe
    this.#unsubscribe = null

    if (unsubscribe !== null) {
      safeguard('periscope.watcher.request.cleanup', unsubscribe)
    }

    await Promise.allSettled([...this.#pendingCompletions])

    if (getActiveWatcher(WatcherName.REQUEST) === this) {
      setActiveWatcher(WatcherName.REQUEST, null)
    }
  }

  /**
   * Open the explicit context parked on `ctx` for the socket-completion listener. Setup failures
   * fall back to an untouched middleware chain, while an error thrown or rejected by `next()` is
   * deliberately returned to AdonisJS unchanged so its normal exception handler remains in
   * control.
   */
  async handle(ctx: HttpContext, next: NextFn) {
    const context = safeguard(
      'periscope.watcher.request.open',
      () => {
        const path = requestPath(ctx.request.url())
        if (
          isDashboardRequest(path, this.#context.config.dashboard.path) ||
          this.#ignoredPathPatterns.some((pattern) => pattern.test(path))
        ) {
          /**
           * Skipping the request batch is only half of request self-exclusion. Without a muted
           * child scope, queries, logs and events raised while rendering the dashboard or an
           * ignored path fall through to the rotating ambient batch instead. The refusal marker
           * carries the same decision to observers, such as the exception reporter, that run
           * outside this scope.
           */
          markIgnoredRequest(ctx)
          return false
        }

        const requestContext = BatchScope.createContext('request')
        attachRequestBatch(ctx, {
          context: requestContext,
          startedHeapUsed: process.memoryUsage().heapUsed,
        })
        this.#openContexts.add(requestContext)

        return requestContext
      },
      null
    )

    if (context === false) {
      let nextStarted = false

      try {
        return await this.#context.recorder.mute(() => {
          nextStarted = true
          return next()
        })
      } catch (error) {
        if (nextStarted) {
          throw error
        }

        safeguard('periscope.watcher.request.mute', () => {
          throw error
        })
        return next()
      }
    }

    if (context === null || context === undefined) {
      return next()
    }

    let nextStarted = false

    try {
      return await BatchScope.runWith(context, () => {
        nextStarted = true
        return next()
      })
    } catch (error) {
      if (nextStarted) {
        throw error
      }

      safeguard('periscope.watcher.request.scope', () => {
        throw error
      })
      safeguard('periscope.watcher.request.detach', () => takeRequestBatch(ctx))
      return next()
    } finally {
      this.#openContexts.delete(context)
      if (nextStarted && findRequestBatch(ctx) === undefined) {
        /**
         * Risk R1's straggler path covers client aborts, where the completion event can take the
         * batch while the handler is still running. Wait for that listener to finish recording
         * and performing its intermediate flush before making the one final retention decision
         * over both fragments.
         */
        const completionFlush = this.#completionFlushes.get(context)
        if (completionFlush !== undefined) {
          await completionFlush
        }
        await safeguardAsync('periscope.watcher.request.stragglers', () =>
          this.#context.recorder.flush(context, 'final')
        )
      }
    }
  }
}

/**
 * Kept as the default export as well as the named one because the registry imports the class by
 * name while application code may instantiate watcher modules conventionally in tests.
 */
export default RequestWatcher
