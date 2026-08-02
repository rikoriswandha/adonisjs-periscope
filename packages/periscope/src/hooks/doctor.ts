/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DASHBOARD_ROUTE_MANIFEST } from '../http/route_manifest.ts'

const CONFIG_EXTENSIONS = ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs'] as const
const REQUEST_MIDDLEWARE_PATH = '@rikology/adonisjs-periscope/middleware/request_watcher'
const PERISCOPE_PROVIDER_PATH = '@rikology/adonisjs-periscope/provider'
const APP_PROVIDER_PATH = '@adonisjs/core/providers/app_provider'
const EARLY_WATCHED_PROVIDERS = [
  '@adonisjs/lucid/database_provider',
  '@adonisjs/lucid/providers/database_provider',
] as const
const DEFAULT_MIGRATIONS_PATH = 'database/migrations'
let configImportVersion = 0

export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL'

export type DoctorCheck = {
  name: string
  status: DoctorStatus
  details: string
}

export type DoctorLogger = {
  log: (message: string) => unknown
}

export type RunDoctorChecksOptions = {
  appRoot: string
  routes?: unknown
  logger: DoctorLogger
}

export type DoctorFixResult = {
  changed: string[]
  skipped: string[]
  warning?: string
}

type DoctorParent = {
  cwd?: unknown
  cwdPath?: unknown
  mode?: unknown
  ui?: {
    logger?: DoctorLogger
  }
}

type RoutesListItem = {
  domain?: unknown
  methods?: unknown
  pattern?: unknown
}

type DoctorHooks = {
  add: (
    event: 'routesCommitted',
    handler: (parent: unknown, routes: unknown) => void | Promise<void>
  ) => unknown
}

type LoadedConfig =
  { found: true; value: unknown } | { found: false; reason: 'missing' | 'unreadable' }

type PeriscopeSettings =
  | {
      valid: true
      storageDriver: 'memory' | 'sqlite-local' | 'database'
      storageConnection?: string
      queryWatcherEnabled: boolean
      dashboardPath: string
    }
  | { valid: false; reason: string }

type DatabaseSettings =
  | {
      valid: true
      defaultConnection: string
      connections: Record<string, Record<string, unknown>>
    }
  | { valid: false; reason: string }

/**
 * Shape accepted by `adonisrc.ts#hooks.init`.
 *
 * Assembler passes its parent instance, hook registry, and index generator to `run`. The doctor
 * only needs the first two, but keeps the third structural argument so the returned object remains
 * assignable without taking a runtime dependency on `@adonisjs/assembler`.
 */
export type PeriscopeDoctorHook = {
  run: (parent: unknown, hooks?: unknown, indexGenerator?: unknown) => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unavailableReason(name: string, config: Extract<LoadedConfig, { found: false }>): string {
  return config.reason === 'missing' ? `${name} is missing` : `${name} could not be loaded`
}

function resolveAppRoot(parent: DoctorParent): string | undefined {
  if (typeof parent.cwdPath === 'string' && parent.cwdPath.length > 0) {
    return parent.cwdPath
  }

  if (parent.cwd instanceof URL && parent.cwd.protocol === 'file:') {
    return fileURLToPath(parent.cwd)
  }
}

/**
 * Init hooks run for serve, test and build. `mode` is the property unique to Assembler's
 * `DevServer`; limiting work to its three documented values keeps the doctor development-only
 * without importing the class and turning Assembler into a runtime dependency.
 */
function isDevelopmentServer(parent: DoctorParent): boolean {
  return parent.mode === 'hmr' || parent.mode === 'watch' || parent.mode === 'static'
}

async function loadConfig(appRoot: string, relativeStem: string): Promise<LoadedConfig> {
  for (const extension of CONFIG_EXTENSIONS) {
    const filePath = join(appRoot, `${relativeStem}${extension}`)

    try {
      await stat(filePath)
    } catch (error) {
      if (
        isRecord(error) &&
        typeof error.code === 'string' &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        continue
      }

      return { found: false, reason: 'unreadable' }
    }

    try {
      /**
       * The host config filename and extension are selected at runtime. A query token prevents
       * Assembler restarts and isolated fixture apps at the same path from reusing a stale module.
       */
      const moduleUrl = pathToFileURL(filePath)
      moduleUrl.searchParams.set('periscope_doctor', String(configImportVersion++))
      const configModule = (await import(moduleUrl.href)) as { default?: unknown }
      return { found: true, value: configModule.default }
    } catch {
      return { found: false, reason: 'unreadable' }
    }
  }

  return { found: false, reason: 'missing' }
}

function readPeriscopeSettings(config: LoadedConfig): PeriscopeSettings {
  if (!config.found) {
    return { valid: false, reason: unavailableReason('config/periscope', config) }
  }

  try {
    if (!isRecord(config.value)) {
      return { valid: false, reason: 'config/periscope has no object default export' }
    }

    const storage = config.value.storage
    const watchers = config.value.watchers
    const dashboard = config.value.dashboard

    if (!isRecord(storage) || !isRecord(watchers) || !isRecord(dashboard)) {
      return { valid: false, reason: 'config/periscope is not a resolved defineConfig result' }
    }

    const driver = storage.driver
    if (driver !== 'memory' && driver !== 'sqlite-local' && driver !== 'database') {
      return { valid: false, reason: 'config/periscope storage.driver is invalid' }
    }

    const query = watchers.query
    if (!isRecord(query) || typeof query.enabled !== 'boolean') {
      return { valid: false, reason: 'config/periscope watchers.query is invalid' }
    }

    if (typeof dashboard.path !== 'string' || !dashboard.path.startsWith('/')) {
      return { valid: false, reason: 'config/periscope dashboard.path is invalid' }
    }

    const connection = storage.connection
    if (connection !== undefined && typeof connection !== 'string') {
      return { valid: false, reason: 'config/periscope storage.connection is invalid' }
    }

    const dashboardPath =
      dashboard.path === '/' ? '/' : `/${dashboard.path.split('/').filter(Boolean).join('/')}`

    return {
      valid: true,
      storageDriver: driver,
      storageConnection: connection,
      queryWatcherEnabled: query.enabled,
      dashboardPath,
    }
  } catch {
    return { valid: false, reason: 'config/periscope could not be inspected' }
  }
}

function readDatabaseSettings(config: LoadedConfig): DatabaseSettings {
  if (!config.found) {
    return { valid: false, reason: unavailableReason('config/database', config) }
  }

  try {
    if (!isRecord(config.value)) {
      return { valid: false, reason: 'config/database has no object default export' }
    }

    if (typeof config.value.connection !== 'string' || !isRecord(config.value.connections)) {
      return { valid: false, reason: 'config/database has an invalid connection shape' }
    }

    const connections: Record<string, Record<string, unknown>> = {}
    for (const [name, connection] of Object.entries(config.value.connections)) {
      if (!isRecord(connection)) {
        return { valid: false, reason: `config/database connection "${name}" is invalid` }
      }
      connections[name] = connection
    }

    return {
      valid: true,
      defaultConnection: config.value.connection,
      connections,
    }
  } catch {
    return { valid: false, reason: 'config/database could not be inspected' }
  }
}

function nodeCheck(): DoctorCheck {
  const version = process.versions.node
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)

  return {
    name: 'Node.js',
    status: Number.isFinite(major) && major >= 24 ? 'PASS' : 'FAIL',
    details: `v${version}; Periscope requires >=24`,
  }
}

async function fileContainsPeriscopeMigration(filePath: string): Promise<boolean> {
  if (/(?:^|_)create_periscope_tables\.(?:[cm]?[jt]s)$/.test(basename(filePath))) {
    return true
  }

  if (!/\.(?:[cm]?[jt]s)$/.test(filePath)) {
    return false
  }

  try {
    return /\bcreatePeriscopeTables\s*\(/.test(await readFile(filePath, 'utf8'))
  } catch {
    return false
  }
}

async function migrationExists(appRoot: string, paths: readonly string[]): Promise<boolean> {
  for (const configuredPath of paths) {
    const directory = isAbsolute(configuredPath) ? configuredPath : resolve(appRoot, configuredPath)

    let entries: string[]
    try {
      entries = await readdir(directory, { recursive: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (await fileContainsPeriscopeMigration(join(directory, entry))) {
        return true
      }
    }
  }

  return false
}

async function migrationCheck(
  appRoot: string,
  periscope: PeriscopeSettings,
  database: DatabaseSettings
): Promise<DoctorCheck> {
  if (!periscope.valid) {
    return { name: 'Migration', status: 'WARN', details: periscope.reason }
  }

  if (periscope.storageDriver !== 'database') {
    return {
      name: 'Migration',
      status: 'PASS',
      details: `not required for ${periscope.storageDriver}`,
    }
  }

  if (!database.valid) {
    return { name: 'Migration', status: 'WARN', details: database.reason }
  }

  const connectionName = periscope.storageConnection ?? database.defaultConnection
  const connection = database.connections[connectionName]
  if (!connection) {
    return {
      name: 'Migration',
      status: 'FAIL',
      details: `Lucid connection "${connectionName}" does not exist`,
    }
  }

  const migrations = connection.migrations
  let paths: string[] = [DEFAULT_MIGRATIONS_PATH]
  if (migrations !== undefined) {
    if (!isRecord(migrations)) {
      return {
        name: 'Migration',
        status: 'WARN',
        details: `Lucid connection "${connectionName}" has invalid migrations config`,
      }
    }

    if (migrations.paths !== undefined) {
      if (
        !Array.isArray(migrations.paths) ||
        migrations.paths.length === 0 ||
        migrations.paths.some((path) => typeof path !== 'string' || path.length === 0)
      ) {
        return {
          name: 'Migration',
          status: 'WARN',
          details: `Lucid connection "${connectionName}" has invalid migration paths`,
        }
      }
      paths = migrations.paths
    }
  }

  return (await migrationExists(appRoot, paths))
    ? {
        name: 'Migration',
        status: 'PASS',
        details: `Periscope migration found for "${connectionName}"`,
      }
    : {
        name: 'Migration',
        status: 'FAIL',
        details: `Periscope migration missing from ${paths.join(', ')}`,
      }
}

function lucidDebugCheck(periscope: PeriscopeSettings, database: DatabaseSettings): DoctorCheck {
  if (!periscope.valid) {
    return { name: 'Lucid debug', status: 'WARN', details: periscope.reason }
  }

  if (!periscope.queryWatcherEnabled) {
    return { name: 'Lucid debug', status: 'PASS', details: 'query watcher disabled' }
  }

  if (!database.valid) {
    return { name: 'Lucid debug', status: 'WARN', details: database.reason }
  }

  const connectionNames = Object.keys(database.connections)
  if (connectionNames.length === 0) {
    return {
      name: 'Lucid debug',
      status: 'WARN',
      details: 'config/database defines no connections',
    }
  }

  const withoutDebug = connectionNames.filter((name) => database.connections[name]?.debug !== true)

  return withoutDebug.length === 0
    ? {
        name: 'Lucid debug',
        status: 'PASS',
        details: `enabled on ${connectionNames.length} connection(s)`,
      }
    : {
        name: 'Lucid debug',
        status: 'FAIL',
        details: `debug !== true: ${withoutDebug.join(', ')}`,
      }
}

/**
 * Replaces comments with spaces while preserving quoted module specifiers and source offsets.
 */
function maskComments(source: string): string {
  let result = ''
  let index = 0
  let quote: "'" | '"' | '`' | undefined

  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]

    if (quote) {
      result += char
      if (char === '\\') {
        if (next !== undefined) {
          result += next
          index += 2
          continue
        }
      } else if (char === quote) {
        quote = undefined
      }
      index++
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
      result += char
      index++
      continue
    }

    if (char === '/' && next === '/') {
      result += '  '
      index += 2
      while (index < source.length && source[index] !== '\n') {
        result += ' '
        index++
      }
      continue
    }

    if (char === '/' && next === '*') {
      result += '  '
      index += 2
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          result += '  '
          index += 2
          break
        }
        result += source[index] === '\n' ? '\n' : ' '
        index++
      }
      continue
    }

    result += char
    index++
  }

  return result
}

function matchingDelimiter(source: string, start: number, open: string, close: string): number {
  let depth = 0
  let quote: "'" | '"' | '`' | undefined

  for (let index = start; index < source.length; index++) {
    const char = source[index]!
    if (quote) {
      if (char === '\\') {
        index++
      } else if (char === quote) {
        quote = undefined
      }
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === open) {
      depth++
    } else if (char === close && --depth === 0) {
      return index
    }
  }

  return -1
}

async function readScript(
  appRoot: string,
  relativeStem: string
): Promise<
  { found: true; path: string; source: string } | { found: false; reason: 'missing' | 'unreadable' }
> {
  for (const extension of CONFIG_EXTENSIONS) {
    const path = join(appRoot, `${relativeStem}${extension}`)
    try {
      return { found: true, path, source: await readFile(path, 'utf8') }
    } catch (error) {
      if (
        isRecord(error) &&
        typeof error.code === 'string' &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        continue
      }
      return { found: false, reason: 'unreadable' }
    }
  }
  return { found: false, reason: 'missing' }
}

function propertyContainer(
  source: string,
  property: string,
  open: '[' | '{',
  close: ']' | '}'
): { start: number; end: number } | undefined {
  const inspected = maskComments(source)
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [
    ...inspected.matchAll(
      new RegExp(`(?:^|[,{\n])\\s*(?:${escapedProperty}|['"]${escapedProperty}['"])\\s*:`, 'g')
    ),
  ]
  if (matches.length !== 1) return
  const colon = inspected.indexOf(':', matches[0]!.index)
  const start = inspected.indexOf(open, colon + 1)
  if (start === -1 || inspected.slice(colon + 1, start).trim() !== '') return
  const end = matchingDelimiter(inspected, start, open, close)
  return end === -1 ? undefined : { start, end }
}

function directPropertyPositions(
  source: string,
  container: { start: number; end: number },
  property: string
): number[] {
  const inspected = maskComments(source)
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const positions: number[] = []
  let braceDepth = 0
  let squareDepth = 0
  let roundDepth = 0
  let quote: "'" | '"' | '`' | undefined

  for (let index = container.start + 1; index < container.end; index++) {
    const char = inspected[index]!
    if (quote) {
      if (char === '\\') index++
      else if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '{') braceDepth++
    else if (char === '}') braceDepth--
    else if (char === '[') squareDepth++
    else if (char === ']') squareDepth--
    else if (char === '(') roundDepth++
    else if (char === ')') roundDepth--

    if (braceDepth !== 0 || squareDepth !== 0 || roundDepth !== 0) continue
    const candidate = inspected
      .slice(index)
      .match(new RegExp(`^(?:\\s|,)*(?:${escapedProperty}|['"]${escapedProperty}['"])\\s*:`))
    if (candidate) {
      positions.push(index + candidate[0].lastIndexOf(':'))
      index += candidate[0].length - 1
    }
  }
  return positions
}

function firstArrayElement(source: string): string | undefined {
  const open = source.indexOf('[')
  if (open === -1) {
    return
  }

  const close = matchingDelimiter(source, open, '[', ']')
  if (close === -1) {
    return
  }

  let quote: "'" | '"' | '`' | undefined
  let roundDepth = 0
  let squareDepth = 0
  let braceDepth = 0

  for (let index = open + 1; index < close; index++) {
    const char = source[index]!
    if (quote) {
      if (char === '\\') index++
      else if (char === quote) quote = undefined
      continue
    }

    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '(') roundDepth++
    else if (char === ')') roundDepth--
    else if (char === '[') squareDepth++
    else if (char === ']') squareDepth--
    else if (char === '{') braceDepth++
    else if (char === '}') braceDepth--
    else if (char === ',' && roundDepth === 0 && squareDepth === 0 && braceDepth === 0) {
      return source.slice(open + 1, index).trim()
    }
  }

  const element = source.slice(open + 1, close).trim()
  return element || undefined
}

async function middlewareCheck(appRoot: string): Promise<DoctorCheck> {
  let source: string | undefined
  for (const extension of CONFIG_EXTENSIONS) {
    try {
      source = await readFile(join(appRoot, `start/kernel${extension}`), 'utf8')
      break
    } catch {
      // Try the next supported script extension.
    }
  }

  if (source === undefined) {
    return { name: 'Request middleware', status: 'WARN', details: 'start/kernel is missing' }
  }

  const inspected = maskComments(source)
  const middlewarePattern = new RegExp(`(['"])${REQUEST_MIDDLEWARE_PATH.replace('/', '\\/')}\\1`)
  const middlewarePresent = middlewarePattern.test(inspected)
  const serverUse = /\bserver\s*\.\s*use\s*\(/.exec(inspected)

  if (!serverUse) {
    return middlewarePresent
      ? {
          name: 'Request middleware',
          status: 'WARN',
          details: 'middleware found, but server.use could not be inspected',
        }
      : {
          name: 'Request middleware',
          status: 'FAIL',
          details: 'request watcher middleware is not registered',
        }
  }

  const callStart = serverUse.index + serverUse[0].lastIndexOf('(')
  const callEnd = matchingDelimiter(inspected, callStart, '(', ')')
  if (callEnd === -1) {
    return {
      name: 'Request middleware',
      status: 'WARN',
      details: 'server.use call could not be inspected',
    }
  }

  const first = firstArrayElement(inspected.slice(callStart + 1, callEnd))
  if (first === undefined) {
    return {
      name: 'Request middleware',
      status: middlewarePresent ? 'WARN' : 'FAIL',
      details: middlewarePresent
        ? 'middleware found, but the server stack is not an inline array'
        : 'request watcher middleware is not registered',
    }
  }

  const directFirst =
    /^(?:async\s*)?\(\s*\)\s*=>\s*import\s*\(\s*(['"])@rikology\/adonisjs-periscope\/middleware\/request_watcher\1\s*\)\s*$/.test(
      first
    )

  if (directFirst) {
    return {
      name: 'Request middleware',
      status: 'PASS',
      details: 'first in server.use',
    }
  }

  return {
    name: 'Request middleware',
    status: 'FAIL',
    details: middlewarePresent
      ? 'request watcher must be first in server.use'
      : 'request watcher middleware is not registered',
  }
}

async function providerCheck(appRoot: string): Promise<DoctorCheck> {
  const adonisrc = await readScript(appRoot, 'adonisrc')
  if (!adonisrc.found) {
    return {
      name: 'Provider',
      status: 'WARN',
      details: adonisrc.reason === 'missing' ? 'adonisrc is missing' : 'adonisrc could not be read',
    }
  }

  const providers = propertyContainer(adonisrc.source, 'providers', '[', ']')
  if (!providers) {
    return {
      name: 'Provider',
      status: 'WARN',
      details: 'adonisrc providers could not be inspected',
    }
  }

  const source = maskComments(adonisrc.source).slice(providers.start, providers.end + 1)
  const periscopeAt = source.indexOf(PERISCOPE_PROVIDER_PATH)
  if (periscopeAt === -1) {
    return {
      name: 'Provider',
      status: 'FAIL',
      details: `${PERISCOPE_PROVIDER_PATH} is not registered`,
    }
  }

  const appAt = source.indexOf(APP_PROVIDER_PATH)
  if (appAt === -1) {
    return {
      name: 'Provider',
      status: 'WARN',
      details: 'core app provider could not be found; Periscope ordering is unknown',
    }
  }
  if (periscopeAt < appAt) {
    return {
      name: 'Provider',
      status: 'WARN',
      details: 'Periscope must be listed after the core app provider',
    }
  }

  const watchedBefore = EARLY_WATCHED_PROVIDERS.find((provider) => {
    const position = source.indexOf(provider)
    return position !== -1 && position < periscopeAt
  })
  if (watchedBefore) {
    return {
      name: 'Provider',
      status: 'WARN',
      details: `list Periscope before ${watchedBefore} so model watchers attach before Lucid models boot`,
    }
  }

  const descriptorStart = source.lastIndexOf('{', periscopeAt)
  const descriptorEnd =
    descriptorStart === -1 ? -1 : matchingDelimiter(source, descriptorStart, '{', '}')
  if (descriptorStart !== -1 && descriptorEnd > periscopeAt) {
    const descriptor = source.slice(descriptorStart, descriptorEnd + 1)
    const environment = propertyContainer(descriptor, 'environment', '[', ']')
    if (!environment) {
      return {
        name: 'Provider',
        status: 'WARN',
        details: 'provider descriptor should enable web, console, and test environments',
      }
    }
    const environments = descriptor.slice(environment.start, environment.end + 1)
    const missing = ['web', 'console', 'test'].filter(
      (name) => !new RegExp(`['"]${name}['"]`).test(environments)
    )
    if (missing.length > 0) {
      return {
        name: 'Provider',
        status: 'WARN',
        details: `provider environment is missing: ${missing.join(', ')}`,
      }
    }
  } else {
    return {
      name: 'Provider',
      status: 'WARN',
      details: 'use a provider descriptor enabling web, console, and test environments',
    }
  }

  return {
    name: 'Provider',
    status: 'PASS',
    details: 'registered early for web, console, and test',
  }
}

async function exceptionWrapperCheck(appRoot: string): Promise<DoctorCheck> {
  const adonisrc = await readScript(appRoot, 'adonisrc')
  let exceptionsDirectory = 'app/exceptions'
  if (adonisrc.found) {
    const inspected = maskComments(adonisrc.source)
    const configured = /\bexceptions\s*:\s*(['"])([^'"]+)\1/.exec(inspected)
    if (configured) exceptionsDirectory = configured[2]!
  }

  const handler = await readScript(appRoot, `${exceptionsDirectory}/handler`)
  if (!handler.found) {
    return {
      name: 'Exception wrapper',
      status: 'WARN',
      details:
        handler.reason === 'missing'
          ? `${exceptionsDirectory}/handler is missing`
          : `${exceptionsDirectory}/handler could not be read`,
    }
  }

  return /\bwithPeriscope\b/.test(maskComments(handler.source))
    ? {
        name: 'Exception wrapper',
        status: 'PASS',
        details: 'withPeriscope wraps the application exception handler',
      }
    : {
        name: 'Exception wrapper',
        status: 'WARN',
        details: 'withPeriscope is absent; application exceptions will not be recorded',
      }
}

async function shieldCheck(appRoot: string): Promise<DoctorCheck> {
  let packageSource: string
  try {
    packageSource = await readFile(join(appRoot, 'package.json'), 'utf8')
  } catch {
    return { name: 'Shield / CSRF', status: 'WARN', details: 'package.json could not be read' }
  }

  let installed = false
  try {
    const packageJson: unknown = JSON.parse(packageSource)
    if (isRecord(packageJson)) {
      installed = [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ].some((field) => {
        const dependencies = packageJson[field]
        return isRecord(dependencies) && '@adonisjs/shield' in dependencies
      })
    }
  } catch {
    return { name: 'Shield / CSRF', status: 'WARN', details: 'package.json is invalid' }
  }
  if (!installed) {
    return { name: 'Shield / CSRF', status: 'PASS', details: '@adonisjs/shield is not installed' }
  }

  const kernel = await readScript(appRoot, 'start/kernel')
  if (!kernel.found) {
    return {
      name: 'Shield / CSRF',
      status: 'WARN',
      details: 'Shield is installed, but start/kernel could not be inspected',
    }
  }
  if (!/@adonisjs\/shield\/shield_middleware/.test(maskComments(kernel.source))) {
    return {
      name: 'Shield / CSRF',
      status: 'PASS',
      details: 'Shield is installed but its middleware is not registered',
    }
  }

  return {
    name: 'Shield / CSRF',
    status: 'PASS',
    details: 'dashboard mutations fetch /api/csrf-token and send x-csrf-token for Shield',
  }
}

function normalizeRoutePattern(pattern: string): string {
  const segments = pattern.split('/').filter(Boolean)
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

function normalizeRouteMethods(methods: unknown): string[] | undefined {
  const values =
    typeof methods === 'string' ? [methods] : Array.isArray(methods) ? methods : undefined
  if (values === undefined || values.length === 0) {
    return undefined
  }

  const normalizedMethods = new Set<string>()
  for (const method of values) {
    if (typeof method !== 'string' || method.trim() === '') {
      return undefined
    }
    normalizedMethods.add(method.trim().toUpperCase())
  }

  return [...normalizedMethods].sort()
}

function routeSignature(pattern: string, methods: unknown): string {
  const normalizedPattern = normalizeRoutePattern(pattern)
  const normalizedMethods = normalizeRouteMethods(methods)
  return JSON.stringify([normalizedPattern, normalizedMethods ?? null])
}

function routeBelongsToDashboard(pattern: string, root: string): boolean {
  return root === '/' || pattern === root || pattern.startsWith(`${root}/`)
}

function routeCollisionCheck(periscope: PeriscopeSettings, routes: unknown): DoctorCheck {
  if (!periscope.valid) {
    return { name: 'Dashboard routes', status: 'WARN', details: periscope.reason }
  }

  if (!isRecord(routes)) {
    return {
      name: 'Dashboard routes',
      status: 'WARN',
      details: 'Assembler route list could not be inspected',
    }
  }

  try {
    const dashboardRoutes: RoutesListItem[] = []
    for (const domainRoutes of Object.values(routes)) {
      if (!Array.isArray(domainRoutes)) {
        return {
          name: 'Dashboard routes',
          status: 'WARN',
          details: 'Assembler route list has an invalid shape',
        }
      }

      for (const route of domainRoutes) {
        if (
          isRecord(route) &&
          route.domain === 'root' &&
          typeof route.pattern === 'string' &&
          routeBelongsToDashboard(normalizeRoutePattern(route.pattern), periscope.dashboardPath)
        ) {
          dashboardRoutes.push(route)
        }
      }
    }

    const expectedCounts = new Map<string, number>()
    for (const { pattern: routePattern, methods } of DASHBOARD_ROUTE_MANIFEST) {
      const suffix = normalizeRoutePattern(routePattern)
      const pattern =
        periscope.dashboardPath === '/'
          ? suffix
          : suffix === '/'
            ? periscope.dashboardPath
            : `${periscope.dashboardPath}${suffix}`
      const signature = routeSignature(pattern, methods)
      expectedCounts.set(signature, (expectedCounts.get(signature) ?? 0) + 1)
    }

    const actualCounts = new Map<string, number>()
    for (const route of dashboardRoutes) {
      const signature = routeSignature(route.pattern as string, route.methods)
      actualCounts.set(signature, (actualCounts.get(signature) ?? 0) + 1)
    }

    let collisions = 0
    for (const [signature, count] of actualCounts) {
      collisions += Math.max(0, count - (expectedCounts.get(signature) ?? 0))
    }

    return collisions === 0
      ? {
          name: 'Dashboard routes',
          status: 'PASS',
          details: `no collisions under ${periscope.dashboardPath}`,
        }
      : {
          name: 'Dashboard routes',
          status: 'FAIL',
          details: `${collisions} colliding route(s) under ${periscope.dashboardPath}`,
        }
  } catch {
    return {
      name: 'Dashboard routes',
      status: 'WARN',
      details: 'Assembler route list could not be inspected',
    }
  }
}

/**
 * Runs every Periscope diagnostic against a host application.
 */
export async function runDoctorChecks(options: RunDoctorChecksOptions): Promise<DoctorCheck[]> {
  void options.logger
  const [periscopeConfig, databaseConfig] = await Promise.all([
    loadConfig(options.appRoot, 'config/periscope'),
    loadConfig(options.appRoot, 'config/database'),
  ])
  const periscope = readPeriscopeSettings(periscopeConfig)
  const database = readDatabaseSettings(databaseConfig)

  const safe = async (check: Promise<DoctorCheck>, fallback: DoctorCheck): Promise<DoctorCheck> =>
    check.catch(() => fallback)
  const [migration, middleware, provider, exceptionWrapper, shield] = await Promise.all([
    safe(migrationCheck(options.appRoot, periscope, database), {
      name: 'Migration',
      status: 'WARN',
      details: 'migration configuration could not be inspected',
    }),
    safe(middlewareCheck(options.appRoot), {
      name: 'Request middleware',
      status: 'WARN',
      details: 'start/kernel could not be inspected',
    }),
    safe(providerCheck(options.appRoot), {
      name: 'Provider',
      status: 'WARN',
      details: 'adonisrc providers could not be inspected',
    }),
    safe(exceptionWrapperCheck(options.appRoot), {
      name: 'Exception wrapper',
      status: 'WARN',
      details: 'application exception handler could not be inspected',
    }),
    safe(shieldCheck(options.appRoot), {
      name: 'Shield / CSRF',
      status: 'WARN',
      details: 'Shield configuration could not be inspected',
    }),
  ])

  let lucidDebug: DoctorCheck
  try {
    lucidDebug = lucidDebugCheck(periscope, database)
  } catch {
    lucidDebug = {
      name: 'Lucid debug',
      status: 'WARN',
      details: 'config/database could not be inspected',
    }
  }

  return [
    nodeCheck(),
    migration,
    lucidDebug,
    routeCollisionCheck(periscope, options.routes),
    middleware,
    provider,
    exceptionWrapper,
    shield,
  ]
}

/**
 * Conservatively adds `debug: true` to inline Lucid connection object literals.
 */
export async function fixLucidDebugConfig(appRoot: string): Promise<DoctorFixResult> {
  const script = await readScript(appRoot, 'config/database')
  if (!script.found) {
    return {
      changed: [],
      skipped: [],
      warning:
        'config/database could not be read; add debug: true to each Lucid connection manually',
    }
  }
  const loaded = readDatabaseSettings(await loadConfig(appRoot, 'config/database'))
  if (!loaded.valid) {
    return {
      changed: [],
      skipped: [],
      warning: `${loaded.reason}; add debug: true to each Lucid connection manually`,
    }
  }

  const connections = propertyContainer(script.source, 'connections', '{', '}')
  if (!connections) {
    return {
      changed: [],
      skipped: [],
      warning: 'connections is not one unambiguous object literal; add debug: true manually',
    }
  }

  const insertions: { at: number; text: string; name: string }[] = []
  const skipped: string[] = []
  const inspected = maskComments(script.source)
  for (const name of Object.keys(loaded.connections)) {
    const positions = directPropertyPositions(script.source, connections, name)
    if (positions.length !== 1) {
      return {
        changed: [],
        skipped,
        warning: `connection "${name}" is ambiguous; no changes were written`,
      }
    }
    const colon = positions[0]!
    const objectStart = inspected.slice(colon + 1).search(/\S/) + colon + 1
    if (objectStart <= colon || inspected[objectStart] !== '{') {
      return {
        changed: [],
        skipped,
        warning: `connection "${name}" is not an inline object literal; no changes were written`,
      }
    }
    const objectEnd = matchingDelimiter(inspected, objectStart, '{', '}')
    if (objectEnd === -1) {
      return {
        changed: [],
        skipped,
        warning: `connection "${name}" object is ambiguous; no changes were written`,
      }
    }
    const debug = directPropertyPositions(
      script.source,
      { start: objectStart, end: objectEnd },
      'debug'
    )
    if (debug.length > 1) {
      return {
        changed: [],
        skipped,
        warning: `connection "${name}" has ambiguous debug settings; no changes were written`,
      }
    }
    if (debug.length === 1) {
      if (loaded.connections[name]?.debug !== true) {
        return {
          changed: [],
          skipped,
          warning: `connection "${name}" already has a debug setting that is not true; set it to true manually`,
        }
      }
      skipped.push(name)
      continue
    }

    const lineStart = script.source.lastIndexOf('\n', objectStart) + 1
    const keyIndent = /^\s*/.exec(script.source.slice(lineStart, objectStart))?.[0] ?? ''
    const text =
      script.source[objectStart + 1] === '\n' ? `\n${keyIndent}  debug: true,` : ' debug: true,'
    insertions.push({ at: objectStart + 1, text, name })
  }

  if (insertions.length === 0) return { changed: [], skipped }
  let output = script.source
  for (const insertion of insertions.toSorted((left, right) => right.at - left.at)) {
    output = `${output.slice(0, insertion.at)}${insertion.text}${output.slice(insertion.at)}`
  }
  await writeFile(script.path, output, 'utf8')
  return { changed: insertions.map(({ name }) => name), skipped }
}

export function renderDoctorTable(checks: readonly DoctorCheck[]): string {
  const rows = [
    ['Check', 'Status', 'Details'],
    ...checks.map((check) => [check.name, check.status, check.details.replace(/\s+/g, ' ').trim()]),
  ]
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  const line = (row: readonly string[]) =>
    row.map((cell, column) => cell.padEnd(widths[column]!)).join(' | ')
  const separator = widths.map((width) => '-'.repeat(width)).join('-|-')

  return ['Periscope doctor', line(rows[0]!), separator, ...rows.slice(1).map(line)].join('\n')
}

function printTable(parent: DoctorParent, checks: readonly DoctorCheck[]): void {
  const output = renderDoctorTable(checks)

  try {
    const logger = parent.ui?.logger
    if (logger && typeof logger.log === 'function') {
      logger.log(output)
      return
    }
  } catch {
    // A host-supplied logger must not make an init hook fatal. Fall through to console.
  }

  try {
    console.log(output)
  } catch {
    // The doctor's final invariant: diagnostics never prevent the host application from starting.
  }
}

/**
 * Creates the development-only Periscope doctor.
 *
 * Filesystem checks run during Assembler's init phase. The route check waits for Assembler's
 * documented `routesCommitted` hook, because only that list reflects routes registered by
 * providers and imported route files.
 */
export function periscopeDoctor(): PeriscopeDoctorHook {
  return {
    async run(parentValue: unknown, hooksValue?: unknown): Promise<void> {
      try {
        if (!isRecord(parentValue)) return
        const parent = parentValue as DoctorParent
        if (!isDevelopmentServer(parent)) return

        const appRoot = resolveAppRoot(parent)
        if (!appRoot) {
          const unavailable = 'application root is unavailable'
          printTable(parent, [
            nodeCheck(),
            { name: 'Migration', status: 'WARN', details: unavailable },
            { name: 'Lucid debug', status: 'WARN', details: unavailable },
            { name: 'Dashboard routes', status: 'WARN', details: unavailable },
            { name: 'Request middleware', status: 'WARN', details: unavailable },
            { name: 'Provider', status: 'WARN', details: unavailable },
            { name: 'Exception wrapper', status: 'WARN', details: unavailable },
            { name: 'Shield / CSRF', status: 'WARN', details: unavailable },
          ])
          return
        }

        const logger =
          parent.ui?.logger && typeof parent.ui.logger.log === 'function'
            ? parent.ui.logger
            : { log: (_message: string) => undefined }
        const initialChecks = await runDoctorChecks({ appRoot, logger })
        let printed = false
        const printOnce = async (routes: unknown) => {
          if (printed) return
          printed = true
          const checks =
            routes === undefined
              ? initialChecks
              : await runDoctorChecks({ appRoot, routes, logger }).catch(() => initialChecks)
          printTable(parent, checks)
        }

        /**
         * An invalid Periscope config can prevent the application from booting far enough to
         * commit routes. Emit the complete advisory table now instead of waiting on an event.
         */
        if (!initialChecks[3]?.details.includes('Assembler route list')) {
          await printOnce(undefined)
          return
        }

        if (isRecord(hooksValue) && typeof hooksValue.add === 'function') {
          try {
            ;(hooksValue as DoctorHooks).add('routesCommitted', async (_parent, routes) => {
              try {
                await printOnce(routes)
              } catch {
                await printOnce(undefined)
              }
            })
            return
          } catch {
            // Render an unknown route result below when hook registration is unavailable.
          }
        }

        await printOnce(undefined)
      } catch {
        // Doctor checks are advisory and must never abort Assembler or the host application.
      }
    },
  }
}
