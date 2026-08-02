/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DASHBOARD_ROUTE_MANIFEST } from '../http/route_manifest.ts'

const CONFIG_EXTENSIONS = ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs'] as const
const REQUEST_MIDDLEWARE_PATH = '@rikology/adonisjs-periscope/middleware/request_watcher'
const DEFAULT_MIGRATIONS_PATH = 'database/migrations'
let configImportVersion = 0

type DoctorStatus = 'PASS' | 'WARN' | 'FAIL'

type DoctorCheck = {
  name: string
  status: DoctorStatus
  details: string
}

type DoctorLogger = {
  log: (message: string) => unknown
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

function renderTable(checks: readonly DoctorCheck[]): string {
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
  const output = renderTable(checks)

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
 * Configuration and filesystem checks run during Assembler's init phase. The route check waits
 * for Assembler's documented `routesCommitted` hook, because only that list reflects routes
 * registered by providers and imported route files. All five results are then emitted together.
 */
export function periscopeDoctor(): PeriscopeDoctorHook {
  return {
    async run(parentValue: unknown, hooksValue?: unknown): Promise<void> {
      try {
        if (!isRecord(parentValue)) {
          return
        }

        const parent = parentValue as DoctorParent
        if (!isDevelopmentServer(parent)) {
          return
        }

        const appRoot = resolveAppRoot(parent)
        const checks: DoctorCheck[] = [nodeCheck()]

        if (!appRoot) {
          checks.push(
            { name: 'Migration', status: 'WARN', details: 'application root is unavailable' },
            { name: 'Lucid debug', status: 'WARN', details: 'application root is unavailable' },
            {
              name: 'Request middleware',
              status: 'WARN',
              details: 'application root is unavailable',
            }
          )
        } else {
          const [periscopeConfig, databaseConfig] = await Promise.all([
            loadConfig(appRoot, 'config/periscope'),
            loadConfig(appRoot, 'config/database'),
          ])
          const periscope = readPeriscopeSettings(periscopeConfig)
          const database = readDatabaseSettings(databaseConfig)
          const [migration, middleware] = await Promise.all([
            migrationCheck(appRoot, periscope, database).catch((): DoctorCheck => ({
              name: 'Migration',
              status: 'WARN',
              details: 'migration configuration could not be inspected',
            })),
            middlewareCheck(appRoot).catch((): DoctorCheck => ({
              name: 'Request middleware',
              status: 'WARN',
              details: 'start/kernel could not be inspected',
            })),
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
          checks.push(migration, lucidDebug, middleware)

          let printed = false
          const printOnce = (routes: unknown) => {
            if (printed) return
            printed = true
            printTable(parent, [
              checks[0]!,
              checks[1]!,
              checks[2]!,
              routeCollisionCheck(periscope, routes),
              checks[3]!,
            ])
          }
          /**
           * An invalid Periscope config can prevent the application from booting far enough to
           * commit routes. Emit the complete advisory table now instead of waiting on an event
           * that cannot occur; the route row explains why it could not be checked.
           */
          if (!periscope.valid) {
            printOnce(undefined)
            return
          }

          if (isRecord(hooksValue) && typeof hooksValue.add === 'function') {
            try {
              ;(hooksValue as DoctorHooks).add('routesCommitted', async (_parent, routes) => {
                try {
                  printOnce(routes)
                } catch {
                  printOnce(undefined)
                }
              })
              return
            } catch {
              // Render an unknown route result below when hook registration is unavailable.
            }
          }

          printOnce(undefined)
          return
        }

        printTable(parent, [
          checks[0]!,
          checks[1]!,
          checks[2]!,
          {
            name: 'Dashboard routes',
            status: 'WARN',
            details: 'application root is unavailable',
          },
          checks[3]!,
        ])
      } catch {
        // Doctor checks are advisory and must never abort Assembler or the host application.
      }
    },
  }
}
