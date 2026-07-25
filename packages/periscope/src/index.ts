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

export { MemoryStore } from './storage/memory_store.ts'
export type { MemoryStoreOptions } from './storage/memory_store.ts'
export { createStore } from './storage/resolve.ts'

export { ENTRY_TYPES, EntryType, Flag } from './types.ts'
export type {
  BatchContext,
  BatchKind,
  EntryCapsConfig,
  EntryContent,
  EntryQuery,
  EntryTypeCounts,
  FilterHook,
  FlagOptions,
  Paginated,
  PeriscopeConfig,
  PeriscopeStore,
  PruneOptions,
  ResolvedPeriscopeConfig,
  StorageDriverName,
  StoredEntry,
  TagHook,
  Watcher,
} from './types.ts'
