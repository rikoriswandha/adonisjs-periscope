/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The package's main entry point. It re-exports the public surface that exists today; each phase
 * adds to it as watchers, storage drivers and the dashboard land.
 *
 * Subpath exports (`periscope/services/recorder`, `periscope/periscope_config`, `periscope/dump`,
 * …) stay the idiomatic import for AdonisJS applications; this barrel exists for the pieces an
 * extension author composes — custom watchers, custom stores, hooks.
 */

export { dump } from './dump.ts'
export { IncomingEntry } from './entry.ts'
export { safeguard, safeguardAsync, setInternalLogger } from './safeguard.ts'
export type { InternalLogger } from './safeguard.ts'
export { PeriscopeConfigError, PeriscopeError, PeriscopeStorageError } from './errors.ts'

export {
  DEFAULT_REDACT_HEADERS,
  DEFAULT_REDACT_KEYS,
  defineConfig,
  isRecordingEnabled,
} from './define_config.ts'

export { BatchScope } from './recorder/context.ts'
export { AmbientBatch } from './recorder/ambient.ts'
export type { AmbientBatchOptions } from './recorder/ambient.ts'
export { Recorder } from './recorder/recorder.ts'
export type { RecorderOptions } from './recorder/recorder.ts'
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

export { ENTRY_TYPES, EntryType, Flag, WATCHER_NAMES, WatcherName } from './types.ts'
export type {
  BatchContext,
  BatchKind,
  CaptureMode,
  DashboardAuthorize,
  DashboardConfig,
  EntryCapsConfig,
  EntryContent,
  EntryQuery,
  ExceptionGroup,
  ExceptionGroupQuery,
  EntryTypeCounts,
  FilterHook,
  FlagOptions,
  LogLevelName,
  Paginated,
  PeriscopeConfig,
  PeriscopeStore,
  PruneOptions,
  ResolvedPeriscopeConfig,
  ResolvedDashboardConfig,
  ResolvedWatchersConfig,
  StorageDriverName,
  StoredEntry,
  TagHook,
  Watcher,
  WatchersConfig,
} from './types.ts'
