/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Periscope configuration.
 *
 * `config/periscope.ts` is written by the application as a sparse object and handed to
 * {@link defineConfig}, which deep-merges it over the defaults, validates every value and
 * returns the dense {@link ResolvedPeriscopeConfig} the rest of the package reads. Nothing
 * downstream carries its own fallbacks: the recorder, the storage drivers and the watchers all
 * assume every key is present and already correct.
 *
 * Two deliberate design decisions:
 *
 * - This is a plain function, not an AdonisJS config provider. Resolution needs nothing from the
 *   container, and a plain function means an invalid config throws while `config/periscope.ts`
 *   is being imported — the application fails at boot with a readable list of problems instead
 *   of silently recording nothing.
 * - Validation runs to completion and reports *every* problem in one
 *   {@link PeriscopeConfigError}. Fixing a config file one error per boot is miserable, and the
 *   whole pass costs microseconds, once.
 *
 * The unknown-key checks matter more than they look. A typo'd `redaction:` block would otherwise
 * be accepted in silence and leak passwords into the dashboard for months; instead it names the
 * offending key and the accepted set.
 */

import { PeriscopeConfigError } from './errors.ts'
import {
  DEFAULT_REDACT_HEADERS,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_VALUE_PATTERNS,
} from './recorder/redactor.ts'
import { ENTRY_TYPES, EntryType } from './types.ts'
import type {
  CaptureMode,
  DashboardAuthorize,
  FilterHook,
  KeepAlwaysHook,
  LogLevelName,
  PeriscopeConfig,
  PeriscopeStoreFactory,
  PeriscopeWatcherFactory,
  QueueWatcherAdapter,
  ResolvedPeriscopeConfig,
  ResolvedWatchersConfig,
  StorageDriverName,
  TagHook,
} from './types.ts'

/**
 * Re-exported so a `config/periscope.ts` that wants to *extend* the shipped redaction lists
 * rather than replace them needs a single import next to `defineConfig`, instead of reaching
 * into the recorder's internals:
 *
 * ```ts
 * redact: { keys: [...DEFAULT_REDACT_KEYS, 'internal_reference'] }
 * ```
 */
export {
  DEFAULT_REDACT_HEADERS,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_VALUE_PATTERNS,
  REDACT_EMAIL_PATTERN,
} from './recorder/redactor.ts'

/**
 * Top-level keys of `config/periscope.ts`. Doubles as the accepted-key list quoted back to the
 * application when it misspells one.
 *
 * `serialization` is deliberately absent: nothing reads it yet, so `safeSerialize`'s own
 * `SERIALIZER_DEFAULTS` are the only serialisation limits and a config block would be a knob
 * wired to nothing. Writing one is therefore an unknown-key error rather than a silently
 * ignored setting; the block arrives the day a watcher needs to override those defaults.
 */
const TOP_LEVEL_KEYS = [
  'enabled',
  'applicationName',
  'enabledIn',
  'storage',
  'recording',
  'redact',
  'hooks',
  'watchers',
  'dashboard',
] as const

/**
 * Drivers `storage.driver` accepts. Kept as an array because the selector set — including the
 * `custom` factory seam — is fixed, and this order is shown in validation errors.
 */
const STORAGE_DRIVERS: readonly StorageDriverName[] = [
  'memory',
  'sqlite-local',
  'database',
  'custom',
]

/**
 * The driver an application gets when `config/periscope.ts` names none.
 *
 * `sqlite-local` rather than `memory` because the default has to be useful for the thing
 * Periscope is for: entries that survive the restart caused by the crash you are investigating.
 * It costs a file under `tmp/` and no setup at all — no connection to configure, no migration to
 * run, nothing in the application's own database.
 */
const DEFAULT_DRIVER: StorageDriverName = 'sqlite-local'

const DEFAULT_ENABLED_IN: readonly string[] = ['development', 'test']
const DEFAULT_MAX_ENTRIES = 10_000
const DEFAULT_AMBIENT_ROTATION_MS = 10_000
const DEFAULT_PAUSED_FLAG_TTL_MS = 5_000
const DEFAULT_SAMPLE_RATE = 1
const DEFAULT_APPLICATION_NAME = 'default'
const MAX_APPLICATION_NAME_LENGTH = 191
export const DEFAULT_KEEP_ALWAYS: KeepAlwaysHook = () => false

/**
 * Per-batch cap applied to every entry type without one of its own. Queries get a higher one:
 * a single request legitimately runs dozens of them, and the N+1 detector is worthless if the
 * evidence is truncated before the pattern is visible.
 */
const DEFAULT_CAP = 100
const DEFAULT_QUERY_CAP = 200

const DEFAULT_REPLACEMENT = '[REDACTED]'

/**
 * Watcher defaults.
 *
 * The slow thresholds are the interesting numbers. A second is the point at which a human
 * notices either an inbound or outbound request is slow, and 100 ms is the point at which a
 * single query stops being noise in a request that took 300 ms — these are the values Telescope
 * settled on after years of dashboards, and there is no reason to be original about them.
 */
const DEFAULT_REQUEST_SLOW_MS = 1_000
const DEFAULT_RESPONSE_SIZE_LIMIT_KB = 64
const DEFAULT_QUERY_SLOW_MS = 100
const DEFAULT_HTTP_CLIENT_SLOW_MS = 1_000

/**
 * Recorded log levels start at `warn`. The destination runs after pino's own filter, so the
 * effective floor is `max(application logger level, this setting)`. Periscope never raises the
 * host logger's level to recover records that pino has already dropped.
 */
const DEFAULT_LOG_LEVEL: LogLevelName = 'warn'

const LOG_LEVELS: readonly LogLevelName[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
const CAPTURE_MODES: readonly CaptureMode[] = ['dev', 'always', 'never']

/**
 * Where the dashboard lives, and therefore the one URL prefix Periscope refuses to record
 * (§0, invariant 2 — browsing recordings must not create recordings).
 */
const DEFAULT_DASHBOARD_PATH = '/periscope'
const DEFAULT_N_PLUS_ONE_THRESHOLD = 5
const DEFAULT_SSE_MAX_CLIENTS = 5

/**
 * Resolve the application through the request container instead of a process-global service.
 * Multiple Adonis applications may coexist in one process and must keep their production gates
 * isolated.
 */
export const DEFAULT_DASHBOARD_AUTHORIZE: DashboardAuthorize = async ({ containerResolver }) => {
  const app = await containerResolver.make('app')
  return !app.inProduction
}

/**
 * Recognised values of `PERISCOPE_ENABLED`, compared trimmed and lower-cased. Anything else is
 * ignored rather than guessed at — see {@link isRecordingEnabled}.
 */
const ENABLED_OVERRIDES: Record<string, boolean> = {
  '1': true,
  'true': true,
  '0': false,
  'false': false,
}

/**
 * Renders a rejected value for an error message.
 *
 * Never invokes user code: no `toString` on objects, no `JSON.stringify` of a structure that may
 * be a throwing proxy or hold a cycle. A config value can be literally anything, and the
 * validator must not fail while explaining why something else failed.
 */
function describe(value: unknown): string {
  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return 'an array'
  }

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'object':
      return 'an object'
    case 'function':
      return 'a function'
    default:
      return String(value)
  }
}

/**
 * True for values that can be merged key-by-key. Arrays are excluded on purpose — they replace
 * rather than merge — and so is `null`, which is the value a half-finished config file most
 * often holds. `{ storage: null }` must be an error, never a silent fall-through to the
 * defaults.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Records an issue for every key the block does not define. `prefix` is the dotted path of the
 * containing block, with its trailing dot, or `''` at the top level.
 */
function rejectUnknownKeys(
  prefix: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
  issues: string[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push(`${prefix}${key}: unknown option; accepted keys are ${allowed.join(', ')}`)
    }
  }
}

/**
 * Reads one nested block, returning `{}` when it is absent or unusable so the caller can carry
 * on collecting issues from the remaining blocks instead of bailing out at the first mistake.
 *
 * `path` is the dotted route to the block for diagnostics, and defaults to `key` because most
 * blocks sit at the top level where the two are the same. Nested blocks — `watchers.request` and
 * its siblings — must pass it: an issue reading `request.timeout: unknown option` sends the
 * reader looking for a top-level `request` block that does not exist, and the whole point of the
 * dotted paths is that they can be pasted straight back into the config file.
 */
function readBlock(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  issues: string[],
  path: string = key
): Record<string, unknown> {
  const value = input[key]

  if (value === undefined) {
    return {}
  }

  if (!isPlainObject(value)) {
    issues.push(`${path}: must be an object; got ${describe(value)}`)
    return {}
  }

  rejectUnknownKeys(`${path}.`, value, allowed, issues)

  return value
}

/**
 * Every `read*` helper below returns `undefined` for "absent or invalid" and pushes its own
 * issue when the value was present but wrong. The caller then applies the default unconditionally
 * — safe, because a recorded issue means `defineConfig` throws before the resolved object is
 * ever returned.
 */
function readBoolean(path: string, value: unknown, issues: string[]): boolean | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'boolean') {
    issues.push(`${path}: must be a boolean; got ${describe(value)}`)
    return undefined
  }

  return value
}

/**
 * Safe integers only: a cap of `1e21` or `NaN` is a mistake that would otherwise surface as a
 * mystery much later, inside the recorder's accounting or a `LIMIT` clause.
 */
function readInteger(
  path: string,
  value: unknown,
  minimum: number,
  issues: string[]
): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    issues.push(`${path}: must be an integer >= ${minimum}; got ${describe(value)}`)
    return undefined
  }

  return value
}

function readFraction(path: string, value: unknown, issues: string[]): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(`${path}: must be a finite number between 0 and 1; got ${describe(value)}`)
    return undefined
  }

  return value
}

function readString(path: string, value: unknown, issues: string[]): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string') {
    issues.push(`${path}: must be a string; got ${describe(value)}`)
    return undefined
  }

  return value
}

function readNonEmptyString(path: string, value: unknown, issues: string[]): string | undefined {
  const string = readString(path, value, issues)

  if (string === undefined) {
    return undefined
  }

  if (string.trim() === '') {
    issues.push(`${path}: must be a non-empty string`)
    return undefined
  }

  return string
}

/**
 * Arrays are copied, never aliased: the resolved config must not share identity with the
 * application's literal, or a later `config.redact.keys.push()` in user land would mutate what
 * the recorder is using mid-flight.
 */
function readStringArray(path: string, value: unknown, issues: string[]): string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array of non-empty strings; got ${describe(value)}`)
    return undefined
  }

  const items: readonly unknown[] = value
  let valid = true

  for (const [index, item] of items.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      issues.push(`${path}[${index}]: must be a non-empty string; got ${describe(item)}`)
      valid = false
    }
  }

  return valid ? (items as readonly string[]).slice() : undefined
}

/**
 * Value patterns may be disabled independently of key/header redaction. Expressions are cloned
 * while resolving config so neither a caller's `lastIndex` nor later array mutation can alter the
 * live recorder.
 */
function readRegExpArrayOrFalse(
  path: string,
  value: unknown,
  issues: string[]
): RegExp[] | false | undefined {
  if (value === undefined || value === false) {
    return value
  }

  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array of regular expressions or false; got ${describe(value)}`)
    return undefined
  }

  const patterns: RegExp[] = []
  let valid = true
  for (const [index, pattern] of value.entries()) {
    if (!(pattern instanceof RegExp)) {
      issues.push(`${path}[${index}]: must be a regular expression; got ${describe(pattern)}`)
      valid = false
      continue
    }

    patterns.push(new RegExp(pattern.source, pattern.flags))
  }

  return valid ? patterns : undefined
}

function readFunctionArray<T>(path: string, value: unknown, issues: string[]): T[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array of functions; got ${describe(value)}`)
    return undefined
  }

  const items: readonly unknown[] = value
  let valid = true

  for (const [index, item] of items.entries()) {
    if (typeof item !== 'function') {
      issues.push(`${path}[${index}]: must be a function; got ${describe(item)}`)
      valid = false
    }
  }

  return valid ? (items as readonly T[]).slice() : undefined
}

function readFunction<T>(path: string, value: unknown, issues: string[]): T | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'function') {
    issues.push(`${path}: must be a function; got ${describe(value)}`)
    return undefined
  }

  return value as T
}

function readQueueAdapters(
  path: string,
  value: unknown,
  issues: string[]
): QueueWatcherAdapter[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array of queue watcher adapters; got ${describe(value)}`)
    return undefined
  }

  let valid = true
  for (const [index, adapter] of value.entries()) {
    if (
      adapter === null ||
      typeof adapter !== 'object' ||
      typeof (adapter as QueueWatcherAdapter).name !== 'string' ||
      (adapter as QueueWatcherAdapter).name.trim() === '' ||
      typeof (adapter as QueueWatcherAdapter).register !== 'function'
    ) {
      issues.push(`${path}[${index}]: must expose a non-empty name and register(observer) function`)
      valid = false
    }
  }

  return valid ? (value as QueueWatcherAdapter[]).slice() : undefined
}

/**
 * Resolves the sparse `recording.caps` map into a dense one covering every {@link EntryType}.
 *
 * Precedence is explicit per-type value, then the user's `default`, then the built-in per-type
 * default. Densifying here is what lets the recorder's cap check be a single property read on
 * the hot path, with no fallback lookup and no `undefined` branch.
 */
function resolveCaps(value: unknown, issues: string[]): Record<EntryType, number> {
  const overrides: Partial<Record<EntryType | 'default', number>> = {}

  if (isPlainObject(value)) {
    for (const [key, raw] of Object.entries(value)) {
      if (key !== 'default' && !(ENTRY_TYPES as readonly string[]).includes(key)) {
        issues.push(
          `recording.caps.${key}: unknown entry type; accepted keys are default and ` +
            ENTRY_TYPES.join(', ')
        )
        continue
      }

      /**
       * Zero is a legitimate cap: it means "record none of this type", which is how an
       * application turns a single noisy watcher off without disabling Periscope.
       */
      const cap = readInteger(`recording.caps.${key}`, raw, 0, issues)

      if (cap !== undefined) {
        overrides[key as EntryType | 'default'] = cap
      }
    }
  } else if (value !== undefined) {
    issues.push(
      `recording.caps: must be an object mapping entry types to integers; got ${describe(value)}`
    )
  }

  const fallback = overrides.default
  const caps = {} as Record<EntryType, number>

  for (const type of ENTRY_TYPES) {
    caps[type] =
      overrides[type] ?? fallback ?? (type === EntryType.QUERY ? DEFAULT_QUERY_CAP : DEFAULT_CAP)
  }

  return caps
}

/**
 * Reads a value constrained to a fixed set of strings, such as a capture mode or a log level.
 */
function readEnum<T extends string>(
  path: string,
  value: unknown,
  allowed: readonly T[],
  issues: string[]
): T | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    issues.push(`${path}: must be one of ${allowed.join(', ')}; got ${describe(value)}`)
    return undefined
  }

  return value as T
}

/**
 * Resolves the `watchers` block.
 *
 * Core watchers are enabled by default. Integrations that observe session identifiers, Redis
 * commands, broadcasts, or external queue infrastructure are explicitly opt-in and subscribe to
 * nothing until enabled.
 */
function resolveWatchers(input: Record<string, unknown>, issues: string[]): ResolvedWatchersConfig {
  const watchers = readBlock(
    input,
    'watchers',
    [
      'request',
      'query',
      'exception',
      'log',
      'event',
      'command',
      'mail',
      'cache',
      'model',
      'gate',
      'dump',
      'view',
      'http_client',
      'health_check',
      'transmit',
      'job_schedule',
      'redis',
      'session',
      'custom',
    ],
    issues
  )

  const request = readBlock(
    watchers,
    'request',
    [
      'enabled',
      'slowMs',
      'captureResponse',
      'captureInertia',
      'responseSizeLimitKb',
      'captureSession',
      'ignorePaths',
    ],
    issues,
    'watchers.request'
  )
  const query = readBlock(
    watchers,
    'query',
    ['enabled', 'slowMs', 'hideBindings'],
    issues,
    'watchers.query'
  )
  const exception = readBlock(
    watchers,
    'exception',
    ['enabled', 'captureCodeFrame', 'captureProcessErrors'],
    issues,
    'watchers.exception'
  )
  const log = readBlock(watchers, 'log', ['enabled', 'level'], issues, 'watchers.log')
  const event = readBlock(watchers, 'event', ['enabled', 'ignore'], issues, 'watchers.event')
  const command = readBlock(
    watchers,
    'command',
    ['enabled', 'ignore', 'captureOutput'],
    issues,
    'watchers.command'
  )
  const mail = readBlock(watchers, 'mail', ['enabled'], issues, 'watchers.mail')
  const cache = readBlock(watchers, 'cache', ['enabled', 'captureValues'], issues, 'watchers.cache')
  const model = readBlock(watchers, 'model', ['enabled', 'captureDirty'], issues, 'watchers.model')
  const gate = readBlock(watchers, 'gate', ['enabled', 'ignoreAbilities'], issues, 'watchers.gate')
  const dump = readBlock(watchers, 'dump', ['enabled'], issues, 'watchers.dump')
  const view = readBlock(watchers, 'view', ['enabled', 'captureDataKeys'], issues, 'watchers.view')
  const httpClient = readBlock(
    watchers,
    'http_client',
    ['enabled', 'slowMs'],
    issues,
    'watchers.http_client'
  )
  const healthCheck = readBlock(
    watchers,
    'health_check',
    ['enabled'],
    issues,
    'watchers.health_check'
  )
  const transmit = readBlock(
    watchers,
    'transmit',
    ['enabled', 'capturePayload'],
    issues,
    'watchers.transmit'
  )
  const jobSchedule = readBlock(
    watchers,
    'job_schedule',
    ['enabled', 'adapters', 'capturePayload'],
    issues,
    'watchers.job_schedule'
  )
  const redis = readBlock(
    watchers,
    'redis',
    ['enabled', 'captureArguments'],
    issues,
    'watchers.redis'
  )
  const session = readBlock(
    watchers,
    'session',
    ['enabled', 'captureValues'],
    issues,
    'watchers.session'
  )
  const custom = readFunctionArray<PeriscopeWatcherFactory>(
    'watchers.custom',
    watchers.custom,
    issues
  )

  return {
    request: {
      enabled: readBoolean('watchers.request.enabled', request.enabled, issues) ?? true,
      slowMs:
        readInteger('watchers.request.slowMs', request.slowMs, 0, issues) ??
        DEFAULT_REQUEST_SLOW_MS,
      captureResponse:
        readBoolean('watchers.request.captureResponse', request.captureResponse, issues) ?? true,
      captureInertia:
        readBoolean('watchers.request.captureInertia', request.captureInertia, issues) ?? true,
      responseSizeLimitKb:
        readInteger(
          'watchers.request.responseSizeLimitKb',
          request.responseSizeLimitKb,
          0,
          issues
        ) ?? DEFAULT_RESPONSE_SIZE_LIMIT_KB,
      captureSession:
        readBoolean('watchers.request.captureSession', request.captureSession, issues) ?? true,
      ignorePaths:
        readStringArray('watchers.request.ignorePaths', request.ignorePaths, issues) ?? [],
    },
    query: {
      enabled: readBoolean('watchers.query.enabled', query.enabled, issues) ?? true,
      slowMs:
        readInteger('watchers.query.slowMs', query.slowMs, 0, issues) ?? DEFAULT_QUERY_SLOW_MS,
      hideBindings: readBoolean('watchers.query.hideBindings', query.hideBindings, issues) ?? false,
    },
    exception: {
      enabled: readBoolean('watchers.exception.enabled', exception.enabled, issues) ?? true,
      captureCodeFrame:
        readEnum<CaptureMode>(
          'watchers.exception.captureCodeFrame',
          exception.captureCodeFrame,
          CAPTURE_MODES,
          issues
        ) ?? 'dev',
      captureProcessErrors:
        readBoolean(
          'watchers.exception.captureProcessErrors',
          exception.captureProcessErrors,
          issues
        ) ?? true,
    },
    log: {
      enabled: readBoolean('watchers.log.enabled', log.enabled, issues) ?? true,
      level:
        readEnum<LogLevelName>('watchers.log.level', log.level, LOG_LEVELS, issues) ??
        DEFAULT_LOG_LEVEL,
    },
    event: {
      enabled: readBoolean('watchers.event.enabled', event.enabled, issues) ?? true,
      ignore: readStringArray('watchers.event.ignore', event.ignore, issues) ?? [],
    },
    command: {
      enabled: readBoolean('watchers.command.enabled', command.enabled, issues) ?? true,
      ignore: readStringArray('watchers.command.ignore', command.ignore, issues) ?? [],
      captureOutput:
        readBoolean('watchers.command.captureOutput', command.captureOutput, issues) ?? true,
    },
    mail: {
      enabled: readBoolean('watchers.mail.enabled', mail.enabled, issues) ?? true,
    },
    cache: {
      enabled: readBoolean('watchers.cache.enabled', cache.enabled, issues) ?? true,
      captureValues:
        readBoolean('watchers.cache.captureValues', cache.captureValues, issues) ?? false,
    },
    model: {
      enabled: readBoolean('watchers.model.enabled', model.enabled, issues) ?? true,
      captureDirty: readBoolean('watchers.model.captureDirty', model.captureDirty, issues) ?? false,
    },
    gate: {
      enabled: readBoolean('watchers.gate.enabled', gate.enabled, issues) ?? true,
      ignoreAbilities:
        readStringArray('watchers.gate.ignoreAbilities', gate.ignoreAbilities, issues) ?? [],
    },
    dump: {
      enabled: readBoolean('watchers.dump.enabled', dump.enabled, issues) ?? true,
    },
    view: {
      enabled: readBoolean('watchers.view.enabled', view.enabled, issues) ?? true,
      captureDataKeys:
        readBoolean('watchers.view.captureDataKeys', view.captureDataKeys, issues) ?? true,
    },
    http_client: {
      enabled: readBoolean('watchers.http_client.enabled', httpClient.enabled, issues) ?? true,
      slowMs:
        readInteger('watchers.http_client.slowMs', httpClient.slowMs, 0, issues) ??
        DEFAULT_HTTP_CLIENT_SLOW_MS,
    },
    health_check: {
      enabled: readBoolean('watchers.health_check.enabled', healthCheck.enabled, issues) ?? true,
    },
    transmit: {
      enabled: readBoolean('watchers.transmit.enabled', transmit.enabled, issues) ?? false,
      capturePayload:
        readBoolean('watchers.transmit.capturePayload', transmit.capturePayload, issues) ?? false,
    },
    job_schedule: {
      enabled: readBoolean('watchers.job_schedule.enabled', jobSchedule.enabled, issues) ?? false,
      adapters:
        readQueueAdapters('watchers.job_schedule.adapters', jobSchedule.adapters, issues) ?? [],
      capturePayload:
        readBoolean('watchers.job_schedule.capturePayload', jobSchedule.capturePayload, issues) ??
        false,
    },
    redis: {
      enabled: readBoolean('watchers.redis.enabled', redis.enabled, issues) ?? false,
      captureArguments:
        readBoolean('watchers.redis.captureArguments', redis.captureArguments, issues) ?? false,
    },
    session: {
      enabled: readBoolean('watchers.session.enabled', session.enabled, issues) ?? false,
      captureValues:
        readBoolean('watchers.session.captureValues', session.captureValues, issues) ?? false,
    },
    custom: custom ?? [],
  }
}

/**
 * Strips trailing slashes from a URL prefix so that prefix matching can be a plain
 * "equals, or starts with `path + '/'`" test.
 *
 * `'/'` survives as `'/'`: an application that mounts the dashboard at the root is mounting it
 * everywhere, and the request watcher's prefix test then correctly ignores everything.
 */
function normalisePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * Validates `config/periscope.ts` and fills in every default.
 *
 * Merging rules, which are the part applications actually trip over:
 *
 * - Nested blocks merge key-by-key, so `{ storage: { driver: 'memory' } }` keeps the default
 *   `maxEntries`.
 * - Arrays **replace**, they never concatenate. That holds for `enabledIn`, `redact.keys`,
 *   `redact.headers`, `redact.valuePatterns` and both hook lists. To extend the shipped
 *   redaction lists rather than replace them, spread the corresponding exported default.
 * - `recording.caps` is sparse on the way in and dense on the way out.
 * - `storage.connection` stays absent unless the application sets it, rather than being
 *   materialised as an explicit `undefined`.
 *
 * @throws {PeriscopeConfigError} with one issue per problem found, each formatted
 *   `"<dotted.path>: <what is wrong and what is allowed>"`.
 */
export function defineConfig(config: PeriscopeConfig): ResolvedPeriscopeConfig {
  const issues: string[] = []
  let input: Record<string, unknown> = {}

  if (isPlainObject(config)) {
    input = config
    rejectUnknownKeys('', input, TOP_LEVEL_KEYS, issues)
  } else {
    issues.push(`config: must be an object; got ${describe(config)}`)
  }

  const enabled = readBoolean('enabled', input.enabled, issues)
  const applicationName = readNonEmptyString('applicationName', input.applicationName, issues)
  const enabledIn = readStringArray('enabledIn', input.enabledIn, issues)

  if (enabledIn !== undefined && enabledIn.length === 0) {
    issues.push(
      'enabledIn: must list at least one NODE_ENV value; set enabled: false to switch Periscope off'
    )
  }

  if (applicationName !== undefined && applicationName.length > MAX_APPLICATION_NAME_LENGTH) {
    issues.push(
      `applicationName: must be at most ${MAX_APPLICATION_NAME_LENGTH} characters; got ${applicationName.length}`
    )
  }

  const storage = readBlock(
    input,
    'storage',
    ['driver', 'connection', 'factory', 'maxEntries', 'retention'],
    issues
  )
  const rawDriver = storage.driver
  let driver: StorageDriverName | undefined

  if (rawDriver !== undefined) {
    if (
      typeof rawDriver !== 'string' ||
      !(STORAGE_DRIVERS as readonly string[]).includes(rawDriver)
    ) {
      issues.push(
        `storage.driver: unknown driver ${describe(rawDriver)}; must be one of ` +
          STORAGE_DRIVERS.join(', ')
      )
    } else {
      driver = rawDriver as StorageDriverName
    }
  }
  const selectedDriver = driver ?? DEFAULT_DRIVER
  let factory: PeriscopeStoreFactory | undefined

  if (selectedDriver === 'custom') {
    factory = readFunction<PeriscopeStoreFactory>('storage.factory', storage.factory, issues)

    if (storage.factory === undefined) {
      issues.push('storage.factory: is required when storage.driver is "custom"')
    }
  } else if (storage.factory !== undefined) {
    issues.push('storage.factory: is only accepted when storage.driver is "custom"')
  }

  const connection = readNonEmptyString('storage.connection', storage.connection, issues)
  const maxEntries = readInteger('storage.maxEntries', storage.maxEntries, 1, issues)
  const retention = readBlock(
    storage,
    'retention',
    ['hours', 'keepExceptions'],
    issues,
    'storage.retention'
  )
  const retentionHours = readInteger('storage.retention.hours', retention.hours, 1, issues)
  const retentionKeepExceptions = readBoolean(
    'storage.retention.keepExceptions',
    retention.keepExceptions,
    issues
  )

  if (isPlainObject(storage.retention) && retention.hours === undefined) {
    issues.push('storage.retention.hours: is required when storage.retention is configured')
  }

  const recording = readBlock(
    input,
    'recording',
    ['caps', 'sampleRate', 'keepAlways', 'ambientRotationMs', 'pausedFlagTtlMs'],
    issues
  )
  const caps = resolveCaps(recording.caps, issues)
  const sampleRate = readFraction('recording.sampleRate', recording.sampleRate, issues)
  const keepAlways = readFunction<KeepAlwaysHook>(
    'recording.keepAlways',
    recording.keepAlways,
    issues
  )
  const ambientRotationMs = readInteger(
    'recording.ambientRotationMs',
    recording.ambientRotationMs,
    1,
    issues
  )
  const pausedFlagTtlMs = readInteger(
    'recording.pausedFlagTtlMs',
    recording.pausedFlagTtlMs,
    1,
    issues
  )

  const redact = readBlock(
    input,
    'redact',
    ['keys', 'headers', 'valuePatterns', 'replacement'],
    issues
  )
  const redactKeys = readStringArray('redact.keys', redact.keys, issues)
  const redactHeaders = readStringArray('redact.headers', redact.headers, issues)
  const valuePatterns = readRegExpArrayOrFalse('redact.valuePatterns', redact.valuePatterns, issues)
  const replacement = readString('redact.replacement', redact.replacement, issues)

  const hooks = readBlock(input, 'hooks', ['filter', 'tag'], issues)
  const filter = readFunctionArray<FilterHook>('hooks.filter', hooks.filter, issues)
  const tag = readFunctionArray<TagHook>('hooks.tag', hooks.tag, issues)

  const watchers = resolveWatchers(input, issues)

  const dashboard = readBlock(
    input,
    'dashboard',
    ['path', 'authorize', 'nPlusOneThreshold', 'sseMaxClients'],
    issues
  )
  const dashboardPath = readNonEmptyString('dashboard.path', dashboard.path, issues)
  const dashboardAuthorize = readFunction<DashboardAuthorize>(
    'dashboard.authorize',
    dashboard.authorize,
    issues
  )
  const nPlusOneThreshold = readInteger(
    'dashboard.nPlusOneThreshold',
    dashboard.nPlusOneThreshold,
    1,
    issues
  )
  const sseMaxClients = readInteger('dashboard.sseMaxClients', dashboard.sseMaxClients, 1, issues)

  if (dashboardPath !== undefined && !dashboardPath.startsWith('/')) {
    issues.push(`dashboard.path: must start with a slash; got ${describe(dashboardPath)}`)
  }

  if (issues.length > 0) {
    throw new PeriscopeConfigError(issues)
  }

  const resolvedStorage: ResolvedPeriscopeConfig['storage'] = {
    driver: selectedDriver,
    maxEntries: maxEntries ?? DEFAULT_MAX_ENTRIES,
  }

  /**
   * Assigned conditionally so an unset connection is an absent key rather than an own property
   * holding `undefined` — the latter is invisible to `??` but very visible to `deepEqual`, to
   * `Object.keys` and to a Lucid call that would receive it verbatim.
   */
  if (connection !== undefined) {
    resolvedStorage.connection = connection
  }
  if (factory !== undefined) {
    resolvedStorage.factory = factory
  }

  if (retentionHours !== undefined) {
    resolvedStorage.retention = {
      hours: retentionHours,
      ...(retentionKeepExceptions === undefined ? {} : { keepExceptions: retentionKeepExceptions }),
    }
  }

  return {
    enabled: enabled ?? true,
    applicationName: applicationName ?? DEFAULT_APPLICATION_NAME,
    enabledIn: enabledIn ?? [...DEFAULT_ENABLED_IN],
    storage: resolvedStorage,
    recording: {
      caps,
      sampleRate: sampleRate ?? DEFAULT_SAMPLE_RATE,
      keepAlways: keepAlways ?? DEFAULT_KEEP_ALWAYS,
      ambientRotationMs: ambientRotationMs ?? DEFAULT_AMBIENT_ROTATION_MS,
      pausedFlagTtlMs: pausedFlagTtlMs ?? DEFAULT_PAUSED_FLAG_TTL_MS,
    },
    redact: {
      keys: redactKeys ?? [...DEFAULT_REDACT_KEYS],
      headers: redactHeaders ?? [...DEFAULT_REDACT_HEADERS],
      valuePatterns:
        valuePatterns ??
        DEFAULT_REDACT_VALUE_PATTERNS.map((pattern) => new RegExp(pattern.source, pattern.flags)),
      replacement: replacement ?? DEFAULT_REPLACEMENT,
    },
    hooks: {
      filter: filter ?? [],
      tag: tag ?? [],
    },
    watchers,
    dashboard: {
      path: normalisePath(dashboardPath ?? DEFAULT_DASHBOARD_PATH),
      authorize: dashboardAuthorize ?? DEFAULT_DASHBOARD_AUTHORIZE,
      nPlusOneThreshold: nPlusOneThreshold ?? DEFAULT_N_PLUS_ONE_THRESHOLD,
      sseMaxClients: sseMaxClients ?? DEFAULT_SSE_MAX_CLIENTS,
    },
  }
}

/**
 * The environment gate: should this process record at all?
 *
 * Used by the provider when it builds the recorder and again by the dashboard's `authorize`
 * middleware, which is why it lives here rather than inside the recorder —
 * both callers must reach the same verdict from the same rule.
 *
 * `periscopeEnabled` is the raw `process.env.PERISCOPE_ENABLED` string, passed in rather than
 * read here so the function stays pure and testable. A recognised truthy value forces recording
 * on and a recognised falsy value forces it off, both overriding `enabled`/`enabledIn` — that is
 * the escape hatch for "record this one production box for ten minutes" and for "shut it up
 * right now" alike. Anything else, including the empty string a shell exports for an unset
 * variable, is ignored as if the variable were absent: guessing at `PERISCOPE_ENABLED=maybe`
 * would be worse than falling back to the config file.
 */
export function isRecordingEnabled(
  config: Pick<ResolvedPeriscopeConfig, 'enabled' | 'enabledIn'>,
  environment: { nodeEnv: string; periscopeEnabled?: string | undefined }
): boolean {
  const override = environment.periscopeEnabled?.trim().toLowerCase()

  if (override !== undefined && Object.hasOwn(ENABLED_OVERRIDES, override)) {
    return ENABLED_OVERRIDES[override]
  }

  return config.enabled && config.enabledIn.includes(environment.nodeEnv)
}
