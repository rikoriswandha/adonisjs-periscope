/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The package's main entry point. It re-exports the public surface available today.
 *
 * Subpath exports (`@rikology/adonisjs-periscope/services/recorder`, `@rikology/adonisjs-periscope/periscope_config`,
 * `@rikology/adonisjs-periscope/dump`,
 * …) stay the idiomatic import for AdonisJS applications; this barrel exists for the pieces an
 * extension author composes — custom watchers, custom stores, hooks.
 */

export { configure } from '../configure.ts'
export { stubsRoot } from '../stubs/main.ts'

export { dump } from './dump.ts'
export {
  BATCH_EXPORT_FORMAT,
  BATCH_EXPORT_VERSION,
  parseBatchExport,
  serializeBatchExport,
} from './batch_export.ts'
export type { BatchExportV1 } from './batch_export.ts'
export type { StoredEntryTransport } from './http/serialize.ts'
export { IncomingEntry } from './entry.ts'
export { createInProcessFanout } from './fanout.ts'
export { safeguard, safeguardAsync, setInternalLogger } from './safeguard.ts'
export type { InternalLogger } from './safeguard.ts'
export { PeriscopeConfigError, PeriscopeError, PeriscopeStorageError } from './errors.ts'

export {
  DEFAULT_REDACT_HEADERS,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_VALUE_PATTERNS,
  REDACT_EMAIL_PATTERN,
  defineConfig,
  isRecordingEnabled,
} from './define_config.ts'

export { BatchScope } from './recorder/context.ts'
export { AmbientBatch } from './recorder/ambient.ts'
export type { AmbientBatchOptions } from './recorder/ambient.ts'
export { Recorder } from './recorder/recorder.ts'
export type { FlushMode, RecorderOptions } from './recorder/recorder.ts'
export { Redactor } from './recorder/redactor.ts'
export { nextSequence } from './recorder/sequence.ts'
export { SERIALIZER_DEFAULTS, safeSerialize } from './recorder/serializer.ts'
export type { SerializeOptions } from './recorder/serializer.ts'

export { DatabaseStore } from './storage/database_store.ts'
export type { DatabaseStoreOptions } from './storage/database_store.ts'
export { MemoryStore } from './storage/memory_store.ts'
export type { MemoryStoreOptions } from './storage/memory_store.ts'
export { SqliteLocalStore } from './storage/sqlite_local_store.ts'
export type { SqliteLocalStoreOptions } from './storage/sqlite_local_store.ts'
export { createStore } from './storage/resolve.ts'
export type { StoreContext } from './storage/resolve.ts'

export { WatcherRegistry, WATCHER_FACTORIES } from './watchers/registry.ts'
export type { WatcherFactory } from './watchers/registry.ts'
export type { WatcherContext } from './watchers/context.ts'
export { getActiveWatcher, setActiveWatcher } from './watchers/active.ts'
export { familyHash } from './watchers/hash.ts'
export { attachRequestBatch, findRequestBatch, takeRequestBatch } from './watchers/http_batch.ts'
export type { RequestBatch } from './watchers/http_batch.ts'

export { RequestWatcher } from './watchers/request/watcher.ts'
export { RequestWatcherMiddleware } from './watchers/request/middleware.ts'
export type {
  RequestAuthSummary,
  RequestEntryContent,
  RequestFileMetadata,
  RequestInertiaSummary,
  RequestResponseMarker,
} from './watchers/request/types.ts'

export { QueryWatcher } from './watchers/query/watcher.ts'
export { normaliseSql } from './watchers/query/normalise_sql.ts'
export type { QueryEntryContent, QueryError, QueryWatcherStats } from './watchers/query/types.ts'

export { ExceptionWatcher } from './watchers/exception/watcher.ts'
export { withPeriscope } from './watchers/exception/mixin.ts'
export { codeFrame, parseStack } from './watchers/exception/stack.ts'
export { installProcessObservers, uninstallProcessObservers } from './watchers/exception/process.ts'
export type { ProcessObserverOptions } from './watchers/exception/process.ts'
export type {
  ExceptionCodeFrameLine,
  ExceptionEntryContent,
  ExceptionRequestSummary,
  ExceptionStackFrame,
} from './watchers/exception/types.ts'

export { LogWatcher } from './watchers/log/watcher.ts'
export { periscopeLogStream } from './watchers/log/stream.ts'
export type {
  LogEntryContent,
  LogWatcherStats,
  PeriscopeLogStream,
  PeriscopeLogStreamOptions,
} from './watchers/log/types.ts'

export { EventWatcher } from './watchers/event/watcher.ts'
export type { EventEntryContent } from './watchers/event/types.ts'

export { CommandWatcher } from './watchers/command/watcher.ts'
export type { CommandEntryContent } from './watchers/command/types.ts'

export { MailWatcher } from './watchers/mail/watcher.ts'
export type { MailEntryContent } from './watchers/mail/types.ts'

export { CacheWatcher } from './watchers/cache/watcher.ts'
export type { CacheEntryContent } from './watchers/cache/types.ts'

export { ModelWatcher } from './watchers/model/watcher.ts'
export type { ModelEntryContent } from './watchers/model/types.ts'

export { GateWatcher } from './watchers/gate/watcher.ts'
export type { GateEntryContent } from './watchers/gate/types.ts'

export { DumpWatcher } from './watchers/dump/watcher.ts'
export type { DumpEntryContent } from './watchers/dump/types.ts'

export { ViewWatcher } from './watchers/view/watcher.ts'
export type { ViewEntryContent } from './watchers/view/types.ts'

export { HttpClientWatcher } from './watchers/http_client/watcher.ts'
export type { HttpClientEntryContent } from './watchers/http_client/types.ts'

export { HealthCheckWatcher } from './watchers/health_check/watcher.ts'
export type {
  HealthCheckEntryContent,
  HealthCheckResult,
  HealthCheckStatus,
} from './watchers/health_check/types.ts'

export { JobScheduleWatcher } from './watchers/job_schedule/watcher.ts'
export type {
  JobEntryContent,
  ScheduleEntryContent,
  ScheduledTaskEntryContent,
} from './watchers/job_schedule/types.ts'
export { AdonisQueueAdapter } from './watchers/job_schedule/adonis_queue_adapter.ts'

export { RedisWatcher } from './watchers/redis/watcher.ts'
export type { RedisEntryContent } from './watchers/redis/types.ts'

export { SessionWatcher } from './watchers/session/watcher.ts'
export type { SessionEntryContent, SessionOperation } from './watchers/session/types.ts'

export { VineWatcher } from './watchers/vine/watcher.ts'
export type { ValidationEntryContent, ValidationFieldError } from './watchers/vine/types.ts'

export { LimiterWatcher } from './watchers/limiter/watcher.ts'
export type { RateLimitEntryContent } from './watchers/limiter/types.ts'

export { LockWatcher } from './watchers/lock/watcher.ts'
export type { LockEntryContent } from './watchers/lock/types.ts'

export { DriveWatcher } from './watchers/drive/watcher.ts'
export type { DriveEntryContent } from './watchers/drive/types.ts'

export { AllyWatcher } from './watchers/ally/watcher.ts'
export type { AllyEntryContent } from './watchers/ally/types.ts'

export { I18nWatcher } from './watchers/i18n/watcher.ts'
export type { I18nEntryContent } from './watchers/i18n/types.ts'

export { NotificationWatcher } from './watchers/notification/watcher.ts'
export type { NotificationEntryContent } from './watchers/notification/types.ts'

export { SocketWatcher } from './watchers/socket/watcher.ts'
export type { SocketEntryContent } from './watchers/socket/types.ts'

export { ENTRY_TYPES, EntryType, Flag, WATCHER_NAMES, WatcherName } from './types.ts'
export type {
  ApplicationSummary,
  BatchContext,
  BatchEntryView,
  BatchKind,
  CaptureMode,
  BatchView,
  DashboardAuthorize,
  DashboardConfig,
  EntryCapsConfig,
  EntryContent,
  EntryQuery,
  EntrySortKey,
  ExceptionGroupState,
  ExceptionGroup,
  ExceptionGroupQuery,
  EntryTypeCounts,
  FilterHook,
  FlushedEvent,
  FlushFanout,
  FlushFanoutFactory,
  FlushedIndexRow,
  FlushedListener,
  FlagOptions,
  LogLevelName,
  KeepAlwaysHook,
  Paginated,
  PeriscopeConfig,
  PeriscopeStore,
  PeriscopeStoreFactory,
  PeriscopeStoreFactoryContext,
  PeriscopeWatcherFactory,
  PruneOptions,
  QueueJobEvent,
  QueueJobResult,
  QueueWatcherAdapter,
  QueueWatcherRegistrationOptions,
  QueueWatcherObserver,
  NotificationEvent,
  NotificationResult,
  NotificationWatcherAdapter,
  NotificationWatcherObserver,
  NotificationWatcherRegistrationOptions,
  ResolvedPeriscopeConfig,
  ResolvedDashboardConfig,
  ResolvedWatchersConfig,
  ScheduledTaskEvent,
  ScheduledTaskResult,
  SchedulerWatcherAdapter,
  SchedulerWatcherObserver,
  SchedulerWatcherRegistrationOptions,
  SocketConnectionEvent,
  SocketDisconnectionEvent,
  SocketMessageEvent,
  SocketWatcherAdapter,
  SocketWatcherObserver,
  SocketWatcherRegistrationOptions,
  StorageDriverName,
  StoredEntry,
  StoredFlag,
  StoreDiagnostics,
  RequestStatsBucket,
  RequestStatsQuery,
  RequestStatsResult,
  TagHook,
  Watcher,
  WatchersConfig,
} from './types.ts'
