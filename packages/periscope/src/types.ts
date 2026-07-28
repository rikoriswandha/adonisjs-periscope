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
 * 2. **The entry shape is fixed now.** Storage schemas, dashboard routes and every watcher key
 *    off `EntryType` and `StoredEntry`, so those are complete from day one even though most
 *    watchers land later.
 */

import type { HttpContext } from '@adonisjs/core/http'

import type { IncomingEntry } from './entry.ts'

/**
 * Every kind of entry Periscope can record. Watchers are added across phases 1 to 6, but the
 * catalogue is fixed now because storage schemas, dashboard routes and config keys are all
 * derived from it.
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
  HTTP_CLIENT: 'http_client',
  SCHEDULE: 'schedule',
  JOB: 'job',
  NOTIFICATION: 'notification',
  REDIS: 'redis',
  SESSION: 'session',
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
export type BatchKind = 'request' | 'command' | 'queue' | 'test' | 'ambient'

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
 * Filters accepted by {@link PeriscopeStore.list}. Every field is optional and they combine
 * with AND. Results are always ordered by `sequence` descending — newest first.
 */
export type EntryQuery = {
  type?: EntryType

  /**
   * Exact tag match, for example `status:500` or `Auth:42`.
   */
  tag?: string

  familyHash?: string
  batchId?: string
  application?: string

  /**
   * When `true`, only entries a watcher left visible on index screens. Sub-entries hidden with
   * `IncomingEntry#hiddenFromIndex()` are excluded.
   */
  displayOnIndex?: boolean

  /**
   * Opaque cursor from a previous page's `nextCursor`. Returns entries strictly older than the
   * cursor position.
   */
  cursor?: string

  /**
   * Page size. Drivers clamp this to a sane maximum.
   */
  limit?: number
}

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
 * Options accepted by {@link PeriscopeStore.prune}.
 */
export type PruneOptions = {
  /**
   * Delete entries created strictly before this instant.
   */
  before: Date

  /**
   * Never delete `exception` entries, however old. Backs `periscope:prune --keep-exceptions`.
   */
  keepExceptions?: boolean
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
   * Tags the user asked to be monitored. Batches carrying one bypass sampling.
   */
  monitoredTags(): Promise<string[]>

  /**
   * Start monitoring a tag. Monitoring an already-monitored tag is a no-op.
   */
  monitorTag(tag: string): Promise<void>

  /**
   * Stop monitoring a tag. Unmonitoring an unmonitored tag is a no-op.
   */
  unmonitorTag(tag: string): Promise<void>

  /**
   * Read a flag. Resolves `null` when the flag is unset or expired.
   */
  getFlag(name: string): Promise<string | null>

  /**
   * Test whether any unexpired flag name starts with the literal prefix.
   */
  hasFlagWithPrefix(prefix: string): Promise<boolean>

  /**
   * Write a flag, replacing any previous value and expiry.
   */
  setFlag(name: string, value: string, options?: FlagOptions): Promise<void>

  /**
   * Remove a flag. Removing an absent flag is a no-op.
   */
  deleteFlag(name: string): Promise<void>

  /**
   * Release the driver's resources. Called from the provider's shutdown, after the final flush.
   */
  close(): Promise<void>
}

/**
 * Names of the shipped storage drivers.
 *
 * - `memory` — ring buffer, lost on restart. The zero-dependency driver and the test double.
 * - `sqlite-local` — a dedicated better-sqlite3 file under `tmp/`. The zero-config default:
 *   durable across restarts without touching the application's own database.
 * - `database` — the application's own Lucid connection. Requires `@adonisjs/lucid`, its
 *   provider registered, and the Periscope tables created by the shipped migration.
 */
export type StorageDriverName = 'memory' | 'sqlite-local' | 'database'

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
}

export interface QueueWatcherAdapter {
  readonly name: string
  register(
    observer: QueueWatcherObserver
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
  HTTP_CLIENT: 'http_client',
  JOB_SCHEDULE: 'job_schedule',
  REDIS: 'redis',
  SESSION: 'session',
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
     * Requests at or above this many milliseconds are tagged `slow`. Defaults to 1 000.
     */
    slowMs?: number

    /**
     * Capture a preview of the response body. Only text-ish bodies are ever stored; streams and
     * file downloads are recorded as a marker. Defaults to `true`.
     */
    captureResponse?: boolean

    /**
     * Ceiling on the stored response preview, in kilobytes. Defaults to 64.
     */
    responseSizeLimitKb?: number

    /**
     * Store the session contents of the request, when `@adonisjs/session` is installed and the
     * session middleware ran. Values pass through the redactor. Defaults to `true`.
     */
    captureSession?: boolean
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

  http_client?: {
    enabled?: boolean
  }
  job_schedule?: {
    enabled?: boolean
    adapters?: QueueWatcherAdapter[]
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
}

/**
 * The same shape with nothing optional. Watchers read this and never fall back.
 */
export type ResolvedWatchersConfig = {
  request: {
    enabled: boolean
    slowMs: number
    captureResponse: boolean
    responseSizeLimitKb: number
    captureSession: boolean
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
  http_client: {
    enabled: boolean
  }
  job_schedule: {
    enabled: boolean
    adapters: QueueWatcherAdapter[]
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
}

export type ResolvedDashboardConfig = {
  path: string
  authorize: DashboardAuthorize
  nPlusOneThreshold: number
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
     * Hard ceiling on stored entries. The oldest are trimmed away past it. Defaults to 10 000.
     */
    maxEntries?: number
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
   * Per-watcher switches and options. Every watcher is on by default; a watcher turned off here
   * subscribes to nothing at all, which is the difference between "records nothing" and "costs
   * nothing".
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
    maxEntries: number
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
