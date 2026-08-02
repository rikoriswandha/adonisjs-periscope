/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Public type surface of Periscope.
 *
 * This module is the contract every other part of the package is written against: watchers
 * produce `IncomingEntry` values, the recorder turns them into `StoredEntry` values, storage
 * drivers persist and query them, and the dashboard reads them back.
 *
 * Two rules keep it honest as the package grows phase by phase:
 *
 * 1. **No dead knobs.** A configuration key exists here only once something reads it. Config is
 *    resolved by deep-merging user input over defaults, so compatible keys can be added
 *    without breaking an application's `config/periscope.ts`.
 * 2. **The entry shape is stable; the catalogue is open.** Storage schemas, dashboard routes and
 *    every watcher key off `EntryType` and `StoredEntry`. The `StoredEntry` shape is what every
 *    driver persists and must stay compatible, while new `EntryType` values are added as watcher
 *    coverage grows — the storage column is plain text, so a new kind needs no migration.
 */

import type { HttpContext } from '@adonisjs/core/http'
import type { ApplicationService } from '@adonisjs/core/types'

import type { IncomingEntry } from './entry.ts'
import type { WatcherContext } from './watchers/context.ts'

/**
 * Every kind of entry Periscope can record. The catalogue is open, not fixed: storage keeps the
 * type in a plain `varchar(32)` column (see `./storage/database_schema.ts`), so kinds have been
 * added repeatedly — `view`/`health_check`/`broadcast`, later `redis`/`session` — without a
 * schema change. This object is the single place a new kind is declared; config keys, dashboard
 * routes and watcher names are all derived from it.
 */
export const EntryType = {
  REQUEST: 'request',
  QUERY: 'query',
  EXCEPTION: 'exception',
  LOG: 'log',
  EVENT: 'event',
  COMMAND: 'command',
  MAIL: 'mail',
  CACHE: 'cache',
  MODEL: 'model',
  GATE: 'gate',
  DUMP: 'dump',
  VIEW: 'view',
  HTTP_CLIENT: 'http_client',
  SCHEDULE: 'schedule',
  JOB: 'job',
  HEALTH_CHECK: 'health_check',
  BROADCAST: 'broadcast',
  REDIS: 'redis',
  SESSION: 'session',
  VALIDATION: 'validation',
  RATE_LIMIT: 'rate_limit',
  LOCK: 'lock',
  DRIVE: 'drive',
  ALLY: 'ally',
  I18N: 'i18n',
  NOTIFICATION: 'notification',
  SOCKET: 'socket',
} as const

/**
 * Union of the recordable entry types.
 */
export type EntryType = (typeof EntryType)[keyof typeof EntryType]

/**
 * Every member of {@link EntryType}, as an array. Used to resolve per-type configuration maps
 * into dense records so the hot path never falls back to a default lookup.
 */
export const ENTRY_TYPES = Object.values(EntryType) as readonly EntryType[]

/**
 * What caused a batch of entries to be recorded. `ambient` covers everything that happens
 * outside a request, command, queue job or test — it is drained by a rotating module-level
 * context.
 */
export type BatchKind = 'request' | 'command' | 'queue' | 'schedule' | 'test' | 'ambient'

/**
 * The mutable state of one batch: a correlation id, the entries recorded so far, and the
 * bookkeeping the recorder needs to enforce caps.
 *
 * A request-scoped batch lives in an `AsyncLocalStorage` store; everything recorded
 * outside one lands in the rotating ambient batch.
 */
export type BatchContext = {
  /**
   * Correlation id stamped onto every entry of the batch.
   */
  batchId: string

  kind: BatchKind

  /**
   * OpenTelemetry trace active when the batch opened, when the optional API package is present.
   */
  traceId?: string

  /**
   * `process.hrtime.bigint()` at batch open. Used for batch duration, never for ordering
   * across processes.
   */
  startedAt: bigint

  /**
   * Sampling decision made once, when the batch opens. A false value may still be overridden at
   * flush time by `recording.keepAlways` or by a monitored tag.
   */
  sampled: boolean

  /**
   * Retention decision for a sampled-out batch. Intermediate flushes leave `pending` batches
   * buffered so the final flush can evaluate `recording.keepAlways` and monitored tags against
   * the whole batch. A final decision is sticky because asynchronous work may produce a later
   * fragment after the request itself has closed.
   */
  retention: 'pending' | 'kept' | 'dropped'

  /**
   * Entries recorded but not yet flushed.
   */
  buffer: IncomingEntry[]

  /**
   * How many entries of each type have been *accepted* into this batch. Compared against the
   * configured caps.
   */
  counters: EntryTypeCounts

  /**
   * How many entries of each type were dropped because a cap was hit. Reported into the
   * batch's primary entry at flush time.
   */
  truncated: EntryTypeCounts

  /**
   * While `true`, everything recorded in this context is dropped. Set inside `BatchScope.mute`
   * so Periscope's own storage writes cannot record themselves (§0, invariant 2).
   */
  muted: boolean
}

/**
 * Free-form entry payload. Watchers own the shape per type and normally serialise
 * application-owned values before constructing it. The recorder's redaction pass additionally
 * turns nested class instances into bounded plain records before storage.
 *
 * `truncated` is reserved: the recorder writes the per-batch cap overflow counts into the
 * batch's primary entry under that key at flush time.
 */
export type EntryContent = Record<string, unknown>

/**
 * Per-entry-type counters, used for both cap accounting and truncation reporting.
 */
export type EntryTypeCounts = Partial<Record<EntryType, number>>

/**
 * Read-only entry metadata exposed to a sampling `keepAlways` hook.
 */
export type BatchEntryView = {
  readonly uuid: string
  readonly type: EntryType
  readonly content: Readonly<EntryContent>
  readonly tags: readonly string[]
  readonly familyHash: string | null
  readonly displayOnIndex: boolean
}

/**
 * Cheap flush-time facade over one batch. It deliberately exposes predicates rather than the
 * mutable entry buffer itself.
 */
export interface BatchView {
  readonly kind: BatchKind
  readonly size: number
  hasEntryOfType(type: EntryType): boolean
  hasTag(tag: string): boolean
  hasEntryWhere(predicate: (entry: BatchEntryView) => boolean): boolean
}

/**
 * Flush-time sampling override. Returning true keeps the entire batch.
 */
export type KeepAlwaysHook = (batch: BatchView) => boolean

/**
 * An entry as persisted by a storage driver and served to the dashboard.
 *
 * `sequence` is a nanosecond-resolution, wall-clock-anchored, strictly increasing stamp taken
 * at record time. It is the sort key and the pagination cursor — `createdAt` is only
 * millisecond-resolution and ties constantly under load. Transport layers such as the JSON API
 * stringify it, because `bigint` is not JSON-representable.
 */
export type StoredEntry = {
  uuid: string
  batchId: string
  application: string
  type: EntryType
  familyHash: string | null
  content: EntryContent
  tags: string[]
  shouldDisplayOnIndex: boolean
  sequence: bigint
  createdAt: Date
}

/**
 * JSON-safe, content-free metadata sent to live flush subscribers.
 */
export type FlushedIndexRow = {
  readonly uuid: string
  readonly batchId: string
  readonly application: string
  readonly type: EntryType
  readonly familyHash: string | null
  readonly tags: readonly string[]
  readonly shouldDisplayOnIndex: true
  readonly sequence: string
  readonly createdAt: string
}

export type FlushedEvent = {
  readonly type: EntryType
  readonly uuid: string
  readonly indexRow: FlushedIndexRow
}

export type FlushedListener = (event: FlushedEvent) => void | Promise<void>

/**
 * Fan-out seam between recorder flushes and live dashboard subscribers. The default adapter is
 * an in-process listener list, which only reaches clients connected to the same worker. An
 * application running multiple processes can supply a pub/sub-backed adapter (Redis, Transmit)
 * so a flush on any worker reaches every worker's SSE clients.
 */
export interface FlushFanout {
  /**
   * Deliver a flush event to every subscriber, on this worker and — for pub/sub adapters — on
   * every other worker.
   */
  publish(event: FlushedEvent): void | Promise<void>

  /**
   * Subscribe to fanned-out events. Returns an unsubscribe function. Must be idempotent-safe:
   * calling the returned function twice is a no-op.
   */
  subscribe(listener: (event: FlushedEvent) => void): () => void

  /**
   * Release adapter resources on shutdown.
   */
  close?(): void | Promise<void>
}

/**
 * Builds an application-defined fanout adapter during provider boot.
 */
export type FlushFanoutFactory = (
  context: PeriscopeStoreFactoryContext
) => FlushFanout | Promise<FlushFanout>

/**
 * Filters accepted by {@link PeriscopeStore.list}. Every field is optional and they combine
 * with AND. Results are ordered on the composite `(sequence, uuid)` key — newest first unless
 * `direction` asks for the oldest.
 */
export type EntryQuery = {
  type?: EntryType

  /**
   * Exact tag match, for example `status:500` or `Auth:42`.
   */
  tag?: string
  /**
   * Exact tags an entry must carry. Multiple tags use AND semantics. When `tag` is also set, it
   * is merged into this list.
   */
  tags?: string[]

  /**
   * Case-insensitive substring search over the serialized entry content.
   */
  text?: string

  /**
   * Inclusive ISO-datetime bounds on `createdAt`.
   */
  from?: string
  to?: string

  familyHash?: string
  batchId?: string
  application?: string

  /**
   * When `true`, only entries a watcher left visible on index screens. Sub-entries hidden with
   * `IncomingEntry#hiddenFromIndex()` are excluded.
   */
  displayOnIndex?: boolean

  /**
   * Case-insensitive exact match on the `level` field of the entry content — the label the log
   * watcher records (`info`, `error`, or a custom pino level's own label). Entries whose
   * content carries no string `level` never match.
   */
  level?: string

  /**
   * Sort key, checked against the {@link EntrySortKey} allowlist rather than forwarded to the
   * store verbatim. `sequence` — the insertion order the composite cursor is defined over — is
   * the only key today; the field exists so further keys can land without reshaping the query.
   */
  sort?: EntrySortKey

  /**
   * Direction over `sort`; `desc` (newest first) when omitted. Cursors page onward in the
   * requested direction, so a cursor taken under one direction is not valid under the other.
   */
  direction?: 'asc' | 'desc'

  /**
   * Opaque cursor from a previous page's `nextCursor`. Returns entries strictly beyond the
   * cursor position in the requested direction — older under `desc`, newer under `asc`.
   */
  cursor?: string

  /**
   * Only entries whose `sequence` is strictly greater than this value. Drives Last-Event-ID
   * replay on the live stream; unlike `cursor` it is a plain sequence string, not an opaque
   * pagination token.
   */
  afterSequence?: string

  /**
   * Page size. Drivers clamp this to a sane maximum.
   */
  limit?: number
}

/**
 * Sort keys {@link PeriscopeStore.list} accepts. An allowlist, not a passthrough: every key
 * here must be backed by an index and a cursor encoding in every shipped driver.
 */
export type EntrySortKey = 'sequence'

/**
 * A page of results plus the cursor for the next one. `nextCursor` is `null` when the page is
 * the last one.
 */
export type Paginated<T> = {
  data: T[]
  nextCursor: string | null
}

/**
 * One exception family as rendered by the dashboard. `latest` is the newest occurrence and
 * `lastSeen` mirrors its creation time for inexpensive list rendering.
 */
export type ExceptionGroup = {
  familyHash: string
  latest: StoredEntry
  count: number
  lastSeen: Date
}

/**
 * One application represented in a shared store.
 */
export type ApplicationSummary = {
  name: string
  entries: number
  latestAt: Date | null
}

/**
 * Cursor pagination accepted by the exception-family aggregation.
 */
export type ExceptionGroupQuery = {
  /**
   * Exact tag match. Only matching exception occurrences contribute to a family.
   */
  tag?: string

  application?: string

  cursor?: string
  limit?: number
}

/**
 * Triage state of one exception family. `open` is the absence of a persisted state; `resolved`
 * reopens when a newer occurrence arrives; `ignored` sticks regardless of new occurrences.
 */
export type ExceptionGroupState = 'open' | 'resolved' | 'ignored'

/**
 * Time-bucketed request aggregation accepted by {@link PeriscopeStore.requestStats}.
 *
 * `from` and `to` are required, inclusive ISO instants: the window is the caller's decision,
 * and `from` doubles as the alignment origin so the window always starts on a bucket boundary.
 */
export type RequestStatsQuery = {
  application?: string

  /**
   * Inclusive ISO-datetime start of the window; also the origin buckets are aligned to.
   */
  from: string

  /**
   * Inclusive ISO-datetime end of the window.
   */
  to: string

  /**
   * Bucket width in whole seconds. A single bucket spanning the window is legal — it is how the
   * per-route summary table asks for "no time axis".
   */
  bucketSeconds: number

  /**
   * Optional second dimension. `route` groups by `METHOD routePattern`, falling back to the
   * request URL when the router never matched a pattern.
   */
  groupBy?: 'route'
}

/**
 * One aggregated cell: a time bucket, or a (bucket, group) pair when `groupBy` was requested.
 */
export type RequestStatsBucket = {
  /**
   * ISO instant of the bucket's inclusive start.
   */
  bucketStart: string

  /**
   * Group key when the query asked for one, `null` otherwise. Under `groupBy: 'route'`, routes
   * beyond the driver's per-group ceiling are folded into a `null` long-tail group rather than
   * dropped, so bucket totals still add up.
   */
  group: string | null

  count: number

  /**
   * Requests whose recorded status was 500 or above.
   */
  errorCount: number

  /**
   * Nearest-rank duration percentiles in milliseconds; `null` when no entry in the cell carried
   * a finite duration.
   */
  p50: number | null
  p95: number | null
}

/**
 * Result of {@link PeriscopeStore.requestStats}. Buckets are ordered by `bucketStart` ascending,
 * then by group key. Empty cells are omitted — the caller knows the window and can zero-fill.
 */
export type RequestStatsResult = {
  buckets: RequestStatsBucket[]

  /**
   * Request entries aggregated into `buckets`.
   */
  sampled: number

  /**
   * `true` when the driver hit its sampling ceiling and dropped the oldest part of the window.
   * The newest buckets stay exact; the bucket containing the cut-off is partial.
   */
  truncated: boolean
}

/**
 * Options accepted by {@link PeriscopeStore.prune}.
 */
export type PruneOptions = {
  /**
   * Delete entries created strictly before this instant.
   */
  before: Date

  /**
   * Per-type cutoffs overriding `before`. An entry whose type appears here is deleted only when
   * it is older than its own cutoff; every other type uses `before`. `keepExceptions` still
   * wins for `exception` entries.
   */
  perTypeBefore?: Partial<Record<EntryType, Date>>

  /**
   * Never delete `exception` entries, however old. Backs `periscope:prune --keep-exceptions`.
   */
  keepExceptions?: boolean

  /**
   * Delete only entries owned by this application. Omit to prune every application.
   */
  application?: string
}

/**
 * Options accepted by {@link PeriscopeStore.setFlag}.
 */
export type FlagOptions = {
  /**
   * Instant after which the flag reads back as absent. Backs the dashboard's per-tab `dump-open:`
   * leases, which must fail closed if a tab goes away without clearing its lease.
   */
  expiresAt?: Date
}

/**
 * One unexpired flag row, as returned by {@link PeriscopeStore.flagsWithPrefix}.
 */
export type StoredFlag = {
  name: string
  value: string
}

/**
 * Write-path health counters a driver may expose. Served verbatim on `/api/status` so an
 * operator can see back-pressure and loss without reading logs.
 */
export type StoreDiagnostics = {
  /**
   * Batches accepted but not yet durably written.
   */
  pendingBatches: number

  /**
   * Batches dropped because the pending queue was full. Monotonic since process start.
   */
  droppedBatches: number

  /**
   * Batches abandoned after the final retry attempt failed. Monotonic since process start.
   */
  failedBatches: number

  /**
   * Save attempts that failed and were retried. Monotonic since process start.
   */
  retriedBatches: number
}

/**
 * The storage contract. Every driver — memory, sqlite-local and database —
 * implements it, and the shared contract test suite (`tests/storage/contract.ts`) is run
 * against all of them.
 *
 * Implementations must be safe to call concurrently and must never throw for "not found"; they
 * may throw for genuine I/O failures, which the recorder catches and reports internally.
 */
export interface PeriscopeStore {
  /**
   * Persist a flushed batch. Called with every entry of one batch at once so drivers can use a
   * single transaction and batched inserts.
   *
   * Entries are write-once: the recorder mints a fresh uuid per entry and never revises one, so
   * what a driver does with a uuid it has already stored is deliberately left undefined — the
   * memory driver replaces it, the SQL drivers ignore the conflict. Both are conforming, and no
   * caller may depend on either. What every driver *must* do is survive the collision without
   * rejecting: a duplicate must never cost the rest of the batch its entries.
   */
  save(entries: StoredEntry[]): Promise<void>

  /**
   * Look up one entry by uuid. Resolves `null` when it is unknown or already pruned.
   */
  find(uuid: string): Promise<StoredEntry | null>

  /**
   * Newest-first, cursor-paginated query.
   */
  list(query?: EntryQuery): Promise<Paginated<StoredEntry>>

  /**
   * Every entry of one batch, ordered by `sequence` ascending — the order they happened in,
   * which is what the batch timeline screen renders.
   */
  batch(batchId: string): Promise<StoredEntry[]>

  /**
   * Number of stored entries per type. Powers the dashboard sidebar counts. Types with no
   * entries may be omitted.
   */
  counts(application?: string): Promise<EntryTypeCounts>

  /**
   * Time-bucketed aggregates over request entries: counts, error counts and duration
   * percentiles per bucket — and per route when asked. Powers the dashboard's stats endpoint.
   * Drivers push the type, application and window filters into storage; how they aggregate is
   * their own business, but the work must be bounded — `truncated` reports a ceiling was hit.
   */
  requestStats(query: RequestStatsQuery): Promise<RequestStatsResult>

  /**
   * Applications represented in the store, newest activity first.
   */
  applications(): Promise<ApplicationSummary[]>

  /**
   * Exception entries grouped by family hash, ordered by their newest occurrence.
   */
  exceptionGroups(query?: ExceptionGroupQuery): Promise<Paginated<ExceptionGroup>>

  /**
   * Delete entries older than `before`. Resolves the number of entries deleted.
   */
  prune(options: PruneOptions): Promise<number>

  /**
   * Delete the oldest entries until at most `maxEntries` remain. Resolves the number deleted.
   */
  trim(maxEntries: number): Promise<number>

  /**
   * Delete every entry. Monitored tags and flags are left alone — they are user intent, not
   * recorded data.
   */
  clear(application?: string): Promise<void>

  /**
   * Tags the user asked to be monitored, scoped to one application. Batches carrying one bypass
   * sampling. Omitting `application` reads the `default` application's tags.
   */
  monitoredTags(application?: string): Promise<string[]>

  /**
   * Start monitoring a tag for one application. Monitoring an already-monitored tag is a no-op.
   */
  monitorTag(tag: string, application?: string): Promise<void>

  /**
   * Stop monitoring a tag for one application. Unmonitoring an unmonitored tag is a no-op.
   */
  unmonitorTag(tag: string, application?: string): Promise<void>

  /**
   * Read a flag. Resolves `null` when the flag is unset or expired.
   */
  getFlag(name: string): Promise<string | null>

  /**
   * Test whether any unexpired flag name starts with the literal prefix.
   */
  hasFlagWithPrefix(prefix: string): Promise<boolean>

  /**
   * Every unexpired flag whose name starts with the literal prefix, in no guaranteed order.
   * Backs entry metadata and exception triage state, which key flags by prefixed names.
   */
  flagsWithPrefix(prefix: string): Promise<StoredFlag[]>

  /**
   * Write a flag, replacing any previous value and expiry.
   */
  setFlag(name: string, value: string, options?: FlagOptions): Promise<void>

  /**
   * Remove a flag. Removing an absent flag is a no-op.
   */
  deleteFlag(name: string): Promise<void>

  /**
   * Write-path health counters. Optional: drivers without an asynchronous write queue may omit
   * it, and `/api/status` reports `null`.
   */
  diagnostics?(): StoreDiagnostics

  /**
   * Release the driver's resources. Called from the provider's shutdown, after the final flush.
   */
  close(): Promise<void>
}
/**
 * Values available when an application-defined storage factory is invoked.
 */
export type PeriscopeStoreFactoryContext = {
  app: ApplicationService
  config: ResolvedPeriscopeConfig
}

/**
 * Builds an application-defined storage driver during provider boot.
 */
export type PeriscopeStoreFactory = (
  context: PeriscopeStoreFactoryContext
) => PeriscopeStore | Promise<PeriscopeStore>

/**
 * Storage driver selectors: three shipped drivers plus the application-defined extension seam.
 *
 * - `memory` — ring buffer, lost on restart. The zero-dependency driver and the test double.
 * - `sqlite-local` — a dedicated better-sqlite3 file under `tmp/`. The zero-config default:
 *   durable across restarts without touching the application's own database.
 * - `database` — the application's own Lucid connection. Requires `@adonisjs/lucid`, its
 *   provider registered, and the Periscope tables created by the shipped migration.
 * - `custom` — an application-defined durable store returned by `storage.factory`.
 */
export type StorageDriverName = 'memory' | 'sqlite-local' | 'database' | 'custom'

/**
 * Well-known flag names, so the recorder, the commands and the dashboard agree on spelling.
 */
export const Flag = {
  /**
   * Set by `node ace periscope:pause`, cleared by `periscope:resume`. The recorder polls it on
   * a cache window rather than awaiting it on the hot path.
   */
  PAUSED: 'paused',

  /**
   * Namespace base for the dashboard's per-tab dump leases. A legacy exact flag is still read by
   * the watcher for store-level API compatibility.
   */
  DUMP_OPEN: 'dump-open',
} as const

/**
 * Union of the well-known flag names.
 */
export type Flag = (typeof Flag)[keyof typeof Flag]

/**
 * Rejects an entry before it is buffered. Returning `false` drops it.
 *
 * Runs before redaction, so a hook inspecting content sees the raw values — which is the point:
 * dropping is cheaper than scrubbing, and a filter often keys off exactly the values that are
 * about to be scrubbed.
 */
export type FilterHook = (entry: IncomingEntry) => boolean

/**
 * Adds tags to an entry. Runs after redaction, so a hook can safely key off content without
 * leaking a secret into a tag. Returning nothing is fine; returned tags are appended and
 * de-duplicated.
 */
export type TagHook = (entry: IncomingEntry) => string[] | undefined | void

/**
 * Queue lifecycle metadata emitted by pluggable job/schedule adapters.
 */
export type QueueJobEvent = {
  adapter: string
  queue: string
  jobId: string
  name?: string
  payload?: unknown
  attempts?: number
  scheduledAt?: Date
  durationMs?: number

  /**
   * Opaque correlation id planted at dispatch time via
   * {@link QueueWatcherObserver.dispatching} and echoed back by the adapter from job metadata
   * in whichever process executes the job. When present, the dispatch, start and finish
   * lifecycle entries share one batch even across processes.
   */
  correlationId?: string
}

export type QueueJobResult = QueueJobEvent & {
  result?: unknown
  error?: unknown
}

export interface QueueWatcherObserver {
  started(event: QueueJobEvent): void
  completed(event: QueueJobResult): void
  failed(event: QueueJobResult): void
  scheduled(event: QueueJobEvent): void

  /**
   * Called by an adapter when a job is being dispatched, before its payload is serialized.
   * Returns a correlation id the adapter should persist in job metadata and echo back as
   * `event.correlationId` on `started` / `completed` / `failed` — including from a different
   * worker process. Adapters that cannot carry metadata simply never call it.
   */
  dispatching?(event: QueueJobEvent): { correlationId: string }

  /**
   * Called by an adapter around the job handler's execution so work recorded during the run —
   * queries, logs, outgoing requests — is scoped into the job's batch instead of the ambient
   * context. Adapters that cannot wrap execution simply never call it; the final lifecycle
   * entry is then the only correlated record.
   */
  wrapJob?<T>(event: QueueJobEvent, run: () => Promise<T>): Promise<T>
}
export type QueueWatcherRegistrationOptions = {
  /**
   * Include application-owned job payloads and completed results in lifecycle events.
   */
  capturePayload: boolean
}

export interface QueueWatcherAdapter {
  readonly name: string
  register(
    observer: QueueWatcherObserver,
    options?: QueueWatcherRegistrationOptions
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
}

/**
 * Scheduled-task lifecycle metadata emitted by pluggable scheduler adapters. Unlike
 * {@link QueueJobEvent}, this describes an actual cron/task execution — not a delayed queue
 * dispatch.
 */
export type ScheduledTaskEvent = {
  adapter: string

  /**
   * Stable task identifier: the command name, task class name, or whatever the scheduler uses
   * to address the task.
   */
  task: string

  /**
   * Human-readable schedule expression — a cron pattern or an interval description.
   */
  schedule?: string

  /**
   * Identifier of this particular run, when the scheduler has one. Used to pair start and
   * finish events; adapters without run ids pair on `task` alone.
   */
  runId?: string

  durationMs?: number
}

export type ScheduledTaskResult = ScheduledTaskEvent & {
  result?: unknown
  error?: unknown
}

/**
 * Implemented by the job/schedule watcher; called by scheduler adapters. Method names are
 * task-prefixed so one watcher can implement this contract next to
 * {@link QueueWatcherObserver}.
 */
export interface SchedulerWatcherObserver {
  taskStarted(event: ScheduledTaskEvent): void
  taskCompleted(event: ScheduledTaskResult): void
  taskFailed(event: ScheduledTaskResult): void

  /**
   * Called by an adapter around the task handler's execution so work recorded during the run —
   * queries, logs, outgoing requests — is scoped into the task's batch instead of the ambient
   * context. Adapters that cannot wrap execution simply never call it; the final lifecycle
   * entry is then the only record.
   */
  wrapTask?<T>(event: ScheduledTaskEvent, run: () => Promise<T>): Promise<T>
}

export type SchedulerWatcherRegistrationOptions = {
  /**
   * Include application-owned task results in lifecycle events.
   */
  capturePayload: boolean
}

/**
 * Bridges one scheduler package to Periscope, parallel to {@link QueueWatcherAdapter}. There is
 * no official AdonisJS scheduler, so Periscope ships the seam rather than a coupling.
 */
export interface SchedulerWatcherAdapter {
  readonly name: string
  register(
    observer: SchedulerWatcherObserver,
    options?: SchedulerWatcherRegistrationOptions
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
}

/**
 * One notification delivery as reported by a pluggable notification adapter.
 */
export type NotificationEvent = {
  adapter: string

  /**
   * Delivery channel: `mail`, `sms`, `database`, `push`, …
   */
  channel: string

  /**
   * Notification identifier — usually the notification class or template name.
   */
  notification: string

  /**
   * Scalar recipient descriptor. Adapters should pass an id or an already-masked address, never
   * a full user model.
   */
  notifiable?: string | number

  payload?: unknown
  durationMs?: number
}

export type NotificationResult = NotificationEvent & {
  error?: unknown
}

export interface NotificationWatcherObserver {
  sent(event: NotificationEvent): void
  failed(event: NotificationResult): void
}

export type NotificationWatcherRegistrationOptions = {
  /**
   * Include application-owned notification payloads in lifecycle events.
   */
  capturePayload: boolean
}

/**
 * Bridges a notification implementation to Periscope. There is no official AdonisJS
 * notification package — this is a seam, not a coupling.
 */
export interface NotificationWatcherAdapter {
  readonly name: string
  register(
    observer: NotificationWatcherObserver,
    options?: NotificationWatcherRegistrationOptions
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
}

/**
 * One WebSocket connection as reported by a pluggable socket adapter. The transmit watcher
 * covers server-to-client broadcasts; this contract covers the connection lifecycle and
 * inbound traffic Periscope cannot otherwise see.
 */
export type SocketConnectionEvent = {
  adapter: string
  socketId: string

  /**
   * Transport or library label: `ws`, `socket.io`, …
   */
  transport?: string

  /**
   * Channel, room or namespace the event belongs to, when the transport has such a concept.
   */
  channel?: string

  remoteAddress?: string
  userId?: string | number
}

export type SocketDisconnectionEvent = SocketConnectionEvent & {
  reason?: string

  /**
   * How long the connection was open.
   */
  durationMs?: number
}

export type SocketMessageEvent = SocketConnectionEvent & {
  direction: 'inbound' | 'outbound'

  /**
   * Message or event name, when the protocol has one.
   */
  event?: string

  payload?: unknown
  sizeBytes?: number
}

export interface SocketWatcherObserver {
  connected(event: SocketConnectionEvent): void
  disconnected(event: SocketDisconnectionEvent): void
  message(event: SocketMessageEvent): void
}

export type SocketWatcherRegistrationOptions = {
  /**
   * Include message payloads in recorded entries.
   */
  capturePayload: boolean
}

export interface SocketWatcherAdapter {
  readonly name: string
  register(
    observer: SocketWatcherObserver,
    options?: SocketWatcherRegistrationOptions
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
}

/**
 * A watcher: something that subscribes to a source of events and feeds the recorder.
 *
 * The registry resolves enabled watchers from config, calls `register()` inside
 * `safeguard()`, and keeps `cleanup()` for shutdown and for tests that need a clean emitter.
 */
export interface Watcher {
  /**
   * Stable identifier, matching the watcher's config key.
   */
  readonly name: string

  /**
   * Subscribe to the underlying source.
   */
  register(): void | Promise<void>

  /**
   * Unsubscribe. Must be idempotent.
   */
  cleanup?(): void | Promise<void>
}
/**
 * Builds an application-defined watcher from the same dependency object as shipped watchers.
 */
export type PeriscopeWatcherFactory = (context: WatcherContext) => Watcher

/**
 * The shipped watcher catalogue. Each value is also the watcher's config key and its
 * `Watcher.name`, so a watcher is turned off by the same string it is registered under.
 */
export const WatcherName = {
  REQUEST: 'request',
  QUERY: 'query',
  EXCEPTION: 'exception',
  LOG: 'log',
  EVENT: 'event',
  COMMAND: 'command',
  MAIL: 'mail',
  CACHE: 'cache',
  MODEL: 'model',
  GATE: 'gate',
  DUMP: 'dump',
  VIEW: 'view',
  HTTP_CLIENT: 'http_client',
  JOB_SCHEDULE: 'job_schedule',
  HEALTH_CHECK: 'health_check',
  TRANSMIT: 'transmit',
  REDIS: 'redis',
  SESSION: 'session',
  VINE: 'vine',
  LIMITER: 'limiter',
  LOCK: 'lock',
  DRIVE: 'drive',
  ALLY: 'ally',
  I18N: 'i18n',
  NOTIFICATION: 'notification',
  SOCKET: 'socket',
} as const

export type WatcherName = (typeof WatcherName)[keyof typeof WatcherName]

export const WATCHER_NAMES = Object.values(WatcherName) as readonly WatcherName[]

/**
 * When an expensive, developer-facing capture runs.
 *
 * `dev` means "anywhere but production" — the same rule AdonisJS's own exception handler uses
 * for its `debug` flag, and therefore the rule that keeps `NODE_ENV=test` behaving like a
 * developer's machine rather than like a deployment.
 */
export type CaptureMode = 'dev' | 'always' | 'never'

/**
 * Pino's level names, which is what the log watcher filters on.
 */
export type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/**
 * Per-watcher options as an application writes them. Every watcher accepts `enabled`; the rest
 * is watcher-specific.
 */
export type WatchersConfig = {
  request?: {
    enabled?: boolean

    /**
     * Request URL paths to ignore. A `*` matches any run of characters, so `/assets/*` drops
     * requests below that directory.
     */
    ignorePaths?: string[]

    /**
     * Requests at or above this many milliseconds are tagged `slow`. Defaults to 1 000.
     */
    slowMs?: number

    /**
     * Capture a preview of the response body. Only text-ish bodies are ever stored; streams and
     * file downloads are recorded as a marker. Defaults to `true`.
     */
    captureResponse?: boolean

    /**
     * Extract the Inertia component and top-level prop names from captured JSON responses.
     * Response capture must also be enabled. Defaults to `true`.
     */
    captureInertia?: boolean

    /**
     * Ceiling on the stored response preview, in kilobytes. Defaults to 64.
     */
    responseSizeLimitKb?: number

    /**
     * Store the session contents of the request, when `@adonisjs/session` is installed and the
     * session middleware ran. Values pass through the redactor. Defaults to `true`.
     */
    captureSession?: boolean

    /**
     * Record a summarized entry for requests terminated before routing — typically assets served
     * by `@adonisjs/static` when its middleware runs ahead of Periscope's. Off by default: static
     * traffic is high-volume and rarely diagnostic.
     */
    captureStatic?: boolean
  }

  query?: {
    enabled?: boolean

    /**
     * Queries at or above this many milliseconds are tagged `slow`. Defaults to 100.
     */
    slowMs?: number

    /**
     * Drop binding values, keeping only their count. Defaults to `false`.
     */
    hideBindings?: boolean
  }

  exception?: {
    enabled?: boolean

    /**
     * When to read the ±5 source lines around the throwing frame off disk. Defaults to `dev`.
     */
    captureCodeFrame?: CaptureMode

    /**
     * Observe `uncaughtException` and `unhandledRejection`. Purely observational — the process
     * keeps whatever crash semantics it had. Defaults to `true`.
     */
    captureProcessErrors?: boolean
  }

  log?: {
    enabled?: boolean

    /**
     * Lowest level Periscope records from logs that reach its destination. Pino filters first, so
     * the effective floor is `max(application logger level, this setting)`: `debug` cannot recover
     * debug records from an application logger set to `info`. Defaults to `warn`.
     */
    level?: LogLevelName
  }

  event?: {
    enabled?: boolean

    /**
     * Event names to ignore, on top of the framework prefixes the watcher always drops. A `*`
     * matches any run of characters, so `order:*` drops the whole namespace.
     */
    ignore?: string[]
  }

  command?: {
    enabled?: boolean

    /**
     * Command names to ignore in addition to Periscope's own commands.
     */
    ignore?: string[]

    /**
     * Capture the text rendered through Ace's UI logger. Defaults to `true`.
     */
    captureOutput?: boolean
  }

  mail?: {
    enabled?: boolean
  }

  cache?: {
    enabled?: boolean

    /**
     * Capture cache values on hit and write events. Defaults to `false`.
     */
    captureValues?: boolean
  }

  model?: {
    enabled?: boolean

    /**
     * Capture dirty attributes for model updates. Defaults to `false`.
     */
    captureDirty?: boolean
  }

  gate?: {
    enabled?: boolean

    /**
     * Ability names the gate watcher should ignore.
     */
    ignoreAbilities?: string[]
  }

  dump?: {
    enabled?: boolean
  }

  view?: {
    enabled?: boolean

    /**
     * Capture top-level render data keys without reading their values. Defaults to `true`.
     */
    captureDataKeys?: boolean
  }

  http_client?: {
    enabled?: boolean

    /**
     * Tag outbound requests taking at least this many milliseconds as slow. Defaults to 1000.
     */
    slowMs?: number
  }
  health_check?: {
    enabled?: boolean
  }
  transmit?: {
    enabled?: boolean

    /**
     * Capture broadcast payload summaries. Defaults to `false` because payloads are application
     * data and may be sensitive.
     */
    capturePayload?: boolean
  }
  job_schedule?: {
    enabled?: boolean
    adapters?: QueueWatcherAdapter[]

    /**
     * Scheduler adapters reporting real cron/task executions, recorded as `schedule` entries.
     */
    schedulers?: SchedulerWatcherAdapter[]

    /**
     * Capture job payloads and completed results. Defaults to `false`.
     */
    capturePayload?: boolean
  }
  redis?: {
    enabled?: boolean
    captureArguments?: boolean
  }
  session?: {
    enabled?: boolean
    captureValues?: boolean
  }
  vine?: {
    /**
     * Record VineJS validation failures — fields, rules and messages — by wrapping the global
     * error-reporter factory. Covers throwing `validate` and non-throwing `tryValidate` alike.
     * Defaults to `true`; a no-op when `@vinejs/vine` is not installed.
     */
    enabled?: boolean
  }
  limiter?: {
    /**
     * Record `@adonisjs/limiter` rejections as semantic `rate_limit` entries. Defaults to
     * `false` because it patches limiter instances resolved from the container.
     */
    enabled?: boolean
  }
  lock?: {
    enabled?: boolean

    /**
     * Successful acquisitions that waited at least this many milliseconds are recorded as
     * contention; failed acquisitions are always recorded. Defaults to 50.
     */
    contentionMs?: number
  }
  drive?: {
    /**
     * Record `@adonisjs/drive` file operations. Defaults to `false`.
     */
    enabled?: boolean
  }
  ally?: {
    /**
     * Record `@adonisjs/ally` OAuth flow steps. Defaults to `false`.
     */
    enabled?: boolean
  }
  i18n?: {
    /**
     * Record `@adonisjs/i18n` missing-translation reports. Defaults to `true`.
     */
    enabled?: boolean
  }
  notification?: {
    enabled?: boolean
    adapters?: NotificationWatcherAdapter[]

    /**
     * Capture notification payloads. Defaults to `false`.
     */
    capturePayload?: boolean
  }
  socket?: {
    enabled?: boolean
    adapters?: SocketWatcherAdapter[]

    /**
     * Capture inbound/outbound message payloads. Defaults to `false`.
     */
    capturePayload?: boolean
  }
  /**
   * Application-defined watcher factories, registered after all enabled shipped watchers.
   */
  custom?: PeriscopeWatcherFactory[]
}

/**
 * The same shape with nothing optional. Watchers read this and never fall back.
 */
export type ResolvedWatchersConfig = {
  request: {
    enabled: boolean
    slowMs: number
    captureResponse: boolean
    captureInertia: boolean
    responseSizeLimitKb: number
    captureSession: boolean
    captureStatic: boolean
    ignorePaths: string[]
  }
  query: {
    enabled: boolean
    slowMs: number
    hideBindings: boolean
  }
  exception: {
    enabled: boolean
    captureCodeFrame: CaptureMode
    captureProcessErrors: boolean
  }
  log: {
    enabled: boolean
    level: LogLevelName
  }
  event: {
    enabled: boolean
    ignore: string[]
  }
  command: {
    enabled: boolean
    ignore: string[]
    captureOutput: boolean
  }
  mail: {
    enabled: boolean
  }
  cache: {
    enabled: boolean
    captureValues: boolean
  }
  model: {
    enabled: boolean
    captureDirty: boolean
  }
  gate: {
    enabled: boolean
    ignoreAbilities: string[]
  }
  dump: {
    enabled: boolean
  }
  view: {
    enabled: boolean
    captureDataKeys: boolean
  }
  http_client: {
    enabled: boolean
    slowMs: number
  }
  health_check: {
    enabled: boolean
  }
  transmit: {
    enabled: boolean
    capturePayload: boolean
  }
  job_schedule: {
    enabled: boolean
    adapters: QueueWatcherAdapter[]
    schedulers: SchedulerWatcherAdapter[]
    capturePayload: boolean
  }
  redis: {
    enabled: boolean
    captureArguments: boolean
  }
  session: {
    enabled: boolean
    captureValues: boolean
  }
  vine: {
    enabled: boolean
  }
  limiter: {
    enabled: boolean
  }
  lock: {
    enabled: boolean
    contentionMs: number
  }
  drive: {
    enabled: boolean
  }
  ally: {
    enabled: boolean
  }
  i18n: {
    enabled: boolean
  }
  notification: {
    enabled: boolean
    adapters: NotificationWatcherAdapter[]
    capturePayload: boolean
  }
  socket: {
    enabled: boolean
    adapters: SocketWatcherAdapter[]
    capturePayload: boolean
  }
  custom: PeriscopeWatcherFactory[]
}

/**
 * Per-entry-type caps applied within a single batch, plus the fallback used by any type without
 * its own entry.
 */
export type EntryCapsConfig = Partial<Record<EntryType | 'default', number>>

/**
 * Application authorization hook evaluated for every dashboard request. Returning `false`
 * produces a 403.
 */
export type DashboardAuthorize = (ctx: HttpContext) => boolean | Promise<boolean>

export type DashboardConfig = {
  /**
   * URL prefix from which the dashboard is served. Defaults to `/periscope`.
   */
  path?: string

  /**
   * Application-defined access policy. By default, the current application is resolved from
   * each request: production is denied and non-production environments are allowed.
   */
  authorize?: DashboardAuthorize

  /**
   * Number of equal query shapes in a batch at which the dashboard marks an N+1 candidate.
   * Defaults to 5.
   */
  nPlusOneThreshold?: number

  /**
   * Maximum number of simultaneous server-sent event connections to the live dashboard stream.
   * Defaults to 5.
   */
  sseMaxClients?: number

  /**
   * Fan-out adapter factory connecting recorder flushes to live stream subscribers across
   * processes. Defaults to an in-process adapter that only reaches clients of the same worker.
   */
  fanout?: FlushFanoutFactory
}

export type ResolvedDashboardConfig = {
  path: string
  authorize: DashboardAuthorize
  nPlusOneThreshold: number
  sseMaxClients: number
  fanout?: FlushFanoutFactory
}

/**
 * `config/periscope.ts` as an application writes it: every key optional, deep-merged over the
 * defaults by {@link defineConfig}.
 *
 * There is deliberately no `serialization` block here. Serialisation limits live on
 * {@link safeSerialize}'s own `SERIALIZER_DEFAULTS`, and no current caller needs to override
 * them. Per rule 1 above, the key comes back the day a watcher needs to override those defaults,
 * not before; deep-merging over the defaults makes adding it then a non-breaking change to an
 * application's config file.
 */
export type PeriscopeConfig = {
  /**
   * Master switch. Combined with {@link PeriscopeConfig.enabledIn} and the `PERISCOPE_ENABLED`
   * environment variable to decide whether Periscope records at all. Defaults to `true`.
   */
  enabled?: boolean

  /**
   * Stable identity stamped onto every entry. Shared stores use it to separate applications.
   */
  applicationName?: string

  /**
   * `NODE_ENV` values Periscope is allowed to run in. Defaults to `['development', 'test']` —
   * production is opt-in, and opting in is a deliberate act.
   */
  enabledIn?: string[]

  storage?: {
    /**
     * Which driver persists entries. Defaults to `sqlite-local`, a file of Periscope's own
     * under `tmp/`.
     */
    driver?: StorageDriverName

    /**
     * Lucid connection name for the `database` driver. Ignored by other drivers.
     */
    connection?: string

    /**
     * Build the store for the `custom` driver. Required with `driver: 'custom'` and rejected for
     * every shipped driver.
     */
    factory?: PeriscopeStoreFactory

    /**
     * Hard ceiling on stored entries. The oldest are trimmed away past it. Defaults to 10 000.
     */
    maxEntries?: number

    /**
     * Periodically delete entries older than the configured number of hours. Exception entries
     * may be retained independently.
     */
    retention?: {
      hours: number
      keepExceptions?: boolean

      /**
       * Per-type retention windows overriding `hours`. Keep exceptions or mail for a week while
       * pruning queries after a day. `keepExceptions` still wins for `exception` entries.
       */
      perType?: Partial<Record<EntryType, { hours: number }>>
    }
  }

  recording?: {
    /**
     * Per-type caps within one batch. A runaway loop must not turn one request into 50 000
     * query entries. Defaults to `{ default: 100, query: 200 }`.
     */
    caps?: EntryCapsConfig

    /**
     * Fraction of batches retained before flush-time overrides. Decided once when a batch opens.
     * Defaults to 1.
     */
    sampleRate?: number

    /**
     * Keep a sampled-out batch based on its completed entries.
     */
    keepAlways?: KeepAlwaysHook

    /**
     * How often the ambient batch — everything recorded outside a request, command or job — is
     * rotated and flushed, in milliseconds. Defaults to 10 000.
     */
    ambientRotationMs?: number

    /**
     * How long the recorder caches the `paused` flag before re-reading it, in milliseconds.
     * Defaults to 5 000.
     */
    pausedFlagTtlMs?: number

    /**
     * How long a finished batch keeps accepting late entries — fire-and-forget work that
     * inherited the batch's context and recorded after its final flush — before the
     * continuation batch is flushed, in milliseconds. `0` drops late entries silently.
     * Defaults to 2 000.
     */
    lateEntryGraceMs?: number
  }

  redact?: {
    /**
     * Keys whose values are replaced wherever they appear, at any depth. Matching ignores case,
     * underscores, hyphens and spaces, so `apiKey`, `api_key` and `API-KEY` all match `apikey`.
     *
     * Replaces the defaults rather than extending them; spread {@link DEFAULT_REDACT_KEYS} to
     * add to them.
     */
    keys?: string[]

    /**
     * HTTP header names to scrub. Replaces {@link DEFAULT_REDACT_HEADERS}.
     */
    headers?: string[]

    /**
     * Patterns scrubbed from captured string values after key redaction. Strings beyond the
     * serializer's 16 KiB default ceiling are not scanned. Replaces the built-in secret patterns;
     * spread `DEFAULT_REDACT_VALUE_PATTERNS` to extend them. Set to `false` to disable value
     * scanning while retaining key and header redaction.
     *
     * Email addresses are intentionally not included by default. Add `REDACT_EMAIL_PATTERN` when
     * the application treats recorded addresses as sensitive PII.
     */
    valuePatterns?: RegExp[] | false

    /**
     * What redacted values are replaced with. Defaults to `'[REDACTED]'`.
     */
    replacement?: string
  }

  hooks?: {
    /**
     * Drop entries before they are buffered.
     */
    filter?: FilterHook[]

    /**
     * Attach extra tags to entries.
     */
    tag?: TagHook[]
  }

  /**
   * Per-watcher switches and options. Job/schedule, Redis, session, and transmit integrations are
   * off by default; the other shipped watchers are on. A watcher turned off here subscribes to
   * nothing at all, which is the difference between "records nothing" and "costs nothing".
   */
  watchers?: WatchersConfig

  dashboard?: DashboardConfig
}

/**
 * The configuration after {@link defineConfig} has validated it and filled in defaults. This is
 * what the recorder, the storage drivers and the watchers actually read — everything is
 * present, so no consumer needs its own fallbacks.
 */
export type ResolvedPeriscopeConfig = {
  enabled: boolean
  applicationName: string
  enabledIn: string[]
  storage: {
    driver: StorageDriverName
    connection?: string
    factory?: PeriscopeStoreFactory
    maxEntries: number
    retention?: {
      hours: number
      keepExceptions?: boolean
      perType: Partial<Record<EntryType, { hours: number }>>
    }
  }
  recording: {
    /**
     * Dense map: every {@link EntryType} has an entry, resolved from the user's per-type values
     * and their `default`.
     */
    caps: Record<EntryType, number>
    sampleRate: number
    keepAlways: KeepAlwaysHook
    ambientRotationMs: number
    pausedFlagTtlMs: number
    lateEntryGraceMs: number
  }
  redact: {
    keys: string[]
    headers: string[]
    valuePatterns: RegExp[] | false
    replacement: string
  }
  hooks: {
    filter: FilterHook[]
    tag: TagHook[]
  }
  watchers: ResolvedWatchersConfig
  dashboard: ResolvedDashboardConfig
}
