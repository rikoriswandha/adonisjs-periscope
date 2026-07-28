/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { createRequire } from 'node:module'
import { access, readFile, readdir } from 'node:fs/promises'
import { basename } from 'node:path'

import type { Codemods } from '@adonisjs/core/ace/codemods'
import type Configure from '@adonisjs/core/commands/configure'
import type {
  ArrayLiteralExpression,
  ArrowFunction,
  CallExpression,
  ClassDeclaration,
  Node,
  NoSubstitutionTemplateLiteral,
  ObjectLiteralExpression,
  Project,
  PropertyAssignment,
  SourceFile,
  StringLiteral,
} from 'ts-morph'

import { stubsRoot } from './stubs/main.ts'

const PROVIDER_PATH = 'adonisjs-periscope/provider'
const COMMANDS_PATH = 'adonisjs-periscope/commands'
const REQUEST_MIDDLEWARE_PATH = 'adonisjs-periscope/middleware/request_watcher'
const PROVIDER_ENVIRONMENTS = ['web', 'console', 'test'] as const
const DEFAULT_DASHBOARD_PATH = '/periscope'

type StorageDriver = 'sqlite-local' | 'database'
type ConfigurationState = {
  storageDriver?: StorageDriver
  connection?: string
  dashboardPath?: string
}
type ConfigureOutcome = 'configured' | 'already-configured' | 'manual-action' | 'not-applicable'

function isMissingFile(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function fileExists(path: string) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

function quotedValue(source: string, key: string) {
  const match = source.match(new RegExp(`^\\s*${key}\\s*:\\s*(['"])([^'"\\r\\n]+)\\1\\s*,?`, 'm'))
  return match?.[2]
}

function objectBlock(source: string, key: string) {
  const property = new RegExp(`(?:^|[,{}])\\s*${key}\\s*:\\s*\\{`, 'm').exec(source)
  if (!property) return

  const start = source.indexOf('{', property.index + property[0].lastIndexOf('{'))
  let depth = 0
  let quote: "'" | '"' | '`' | undefined
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = start; index < source.length; index++) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = undefined
      }
      continue
    }
    if (character === '/' && next === '/') {
      lineComment = true
      index++
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === '{') depth++
    if (character === '}' && --depth === 0) return source.slice(start, index + 1)
  }
}

function inferConfiguration(source: string): ConfigurationState {
  const storageSource = objectBlock(source, 'storage') ?? ''
  const dashboardSource = objectBlock(source, 'dashboard')
  const driver = quotedValue(storageSource, 'driver')
  const connection = quotedValue(storageSource, 'connection')
  const hasDynamicConnection = /^\s*connection\s*:/m.test(storageSource) && connection === undefined

  return {
    storageDriver:
      !hasDynamicConnection && (driver === 'sqlite-local' || driver === 'database')
        ? driver
        : undefined,
    connection,
    dashboardPath:
      dashboardSource === undefined ? DEFAULT_DASHBOARD_PATH : quotedValue(dashboardSource, 'path'),
  }
}

async function hasPeriscopeMigration(migrationsPath: string) {
  try {
    const entries = await readdir(migrationsPath, { recursive: true })
    return entries.some((entry) =>
      /(?:^|_)create_periscope_tables\.(?:ts|js)$/.test(basename(entry))
    )
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

function sourceFile(project: Project, path: string) {
  return project.getSourceFile(path) ?? project.addSourceFileAtPathIfExists(path)
}

function defineConfigObject(file: SourceFile): ObjectLiteralExpression | undefined {
  const call = file
    .getDescendants()
    .find(
      (node) =>
        node.getKindName() === 'CallExpression' &&
        (node as CallExpression).getExpression().getText() === 'defineConfig'
    ) as CallExpression | undefined
  const argument = call?.getArguments()[0]
  return argument?.getKindName() === 'ObjectLiteralExpression'
    ? (argument as ObjectLiteralExpression)
    : undefined
}

function arrayProperty(
  object: ObjectLiteralExpression,
  name: string
): ArrayLiteralExpression | undefined {
  const property = object.getProperty(name)
  if (property?.getKindName() !== 'PropertyAssignment') return
  const propertyAssignment = property as PropertyAssignment
  const initializer = propertyAssignment.getInitializer()
  return initializer?.getKindName() === 'ArrayLiteralExpression'
    ? (initializer as ArrayLiteralExpression)
    : undefined
}

function importedModule(text: string) {
  const match = text.match(/^\s*\(\s*\)\s*=>\s*import\(\s*(['"])([^'"]+)\1\s*\)\s*$/s)
  return match?.[2]
}

function providerModule(text: string) {
  const direct = importedModule(text)
  if (direct) return direct
  const match = text.match(/\bfile\s*:\s*\(\s*\)\s*=>\s*import\(\s*(['"])([^'"]+)\1\s*\)/s)
  return match?.[2]
}

function isStandardProviderEntry(text: string, modulePath: string) {
  if (importedModule(text) === modulePath) return true
  const propertyNames = [...text.matchAll(/\b([A-Za-z_$][\w$]*)\s*:/g)].map((match) => match[1])
  return (
    providerModule(text) === modulePath &&
    propertyNames.length === 2 &&
    propertyNames[0] === 'file' &&
    propertyNames[1] === 'environment' &&
    /\benvironment\s*:\s*\[[^\]]*\]\s*,?\s*\}\s*$/s.test(text)
  )
}

function providerDescriptor() {
  return `{
      file: () => import('${PROVIDER_PATH}'),
      environment: ['${PROVIDER_ENVIRONMENTS.join("', '")}'],
    }`
}

function warnProviderOrder(command: Configure) {
  command.logger.warning(
    'Periscope could not safely move its provider in adonisrc.ts. Move this environment-scoped entry immediately after the core app/hash providers so its reverse-order shutdown runs last:'
  )
  command.logger.log(providerDescriptor())
}

function providerRegistrationKind(
  command: Configure,
  project: Project
): 'standard' | 'custom' | 'missing' {
  const rcFile = sourceFile(project, command.app.makePath('adonisrc.ts'))
  const config = rcFile && defineConfigObject(rcFile)
  const providers = config && arrayProperty(config, 'providers')
  if (!rcFile || !providers) return 'missing'

  const periscopeEntry = providers
    .getElements()
    .find((element) => providerModule(element.getText()) === PROVIDER_PATH)
  if (periscopeEntry) {
    return isStandardProviderEntry(periscopeEntry.getText(), PROVIDER_PATH) ? 'standard' : 'custom'
  }

  return /\bimport\(\s*(['"])adonisjs-periscope\/provider\1\s*\)/.test(rcFile.getFullText())
    ? 'custom'
    : 'missing'
}

async function configureProviderOrder(
  command: Configure,
  project: Project
): Promise<ConfigureOutcome> {
  const rcFile = sourceFile(project, command.app.makePath('adonisrc.ts'))
  const config = rcFile && defineConfigObject(rcFile)
  const providers = config && arrayProperty(config, 'providers')
  if (!rcFile || !providers) {
    warnProviderOrder(command)
    return 'manual-action'
  }

  const elements = providers.getElements()
  const matches = elements
    .map((element, index) => ({
      index,
      text: element.getText(),
      hasLeadingComments: element.getLeadingCommentRanges().length > 0,
    }))
    .filter(({ text }) => providerModule(text) === PROVIDER_PATH)

  if (
    matches.length !== 1 ||
    matches[0].hasLeadingComments ||
    !isStandardProviderEntry(matches[0].text, PROVIDER_PATH)
  ) {
    warnProviderOrder(command)
    return 'manual-action'
  }

  const remainingModules = elements
    .filter((_, index) => index !== matches[0].index)
    .map((element) => providerModule(element.getText()))
  if (remainingModules[0] !== '@adonisjs/core/providers/app_provider') {
    warnProviderOrder(command)
    return 'manual-action'
  }

  const desiredIndex = remainingModules[1] === '@adonisjs/core/providers/hash_provider' ? 2 : 1
  const currentIndex = matches[0].index
  const descriptor = providerDescriptor()

  if (currentIndex === desiredIndex) {
    if (elements[currentIndex].getText().replace(/\s+/g, '') === descriptor.replace(/\s+/g, '')) {
      return 'already-configured'
    }
    elements[currentIndex].replaceWithText(descriptor)
  } else {
    providers.removeElement(currentIndex)
    providers.insertElement(desiredIndex, descriptor)
  }

  await rcFile.save()
  return 'configured'
}

type StandardServerStack = {
  kernel: SourceFile
  stack: ArrayLiteralExpression
}

function standardServerStack(project: Project, kernelPath: string) {
  const kernel = sourceFile(project, kernelPath)
  if (!kernel) return
  const calls = kernel
    .getDescendants()
    .filter(
      (node) =>
        node.getKindName() === 'CallExpression' &&
        (node as CallExpression).getExpression().getText() === 'server.use'
    ) as CallExpression[]
  const argument = calls[0]?.getArguments()[0]
  if (calls.length === 0 || argument?.getKindName() !== 'ArrayLiteralExpression') return
  return { kernel, stack: argument as ArrayLiteralExpression }
}

function dynamicImportModule(node: Node) {
  if (node.getKindName() !== 'CallExpression') return
  const call = node as CallExpression
  if (call.getExpression().getText() !== 'import' || call.getArguments().length !== 1) return
  const argument = call.getArguments()[0]
  if (argument.getKindName() === 'StringLiteral') {
    return (argument as StringLiteral).getLiteralValue()
  }
  if (argument.getKindName() === 'NoSubstitutionTemplateLiteral') {
    return (argument as NoSubstitutionTemplateLiteral).getLiteralValue()
  }
}

function middlewareThunkModule(node: Node) {
  if (node.getKindName() !== 'ArrowFunction') return
  const thunk = node as ArrowFunction
  if (thunk.getParameters().length !== 0) return
  return dynamicImportModule(thunk.getBody())
}

function inspectRequestMiddleware(kernel: SourceFile, stack: ArrayLiteralExpression) {
  const safeMatches = stack
    .getElements()
    .map((element, index) => ({
      element,
      index,
      modulePath: middlewareThunkModule(element),
      hasLeadingComments: element.getLeadingCommentRanges().length > 0,
    }))
    .filter(({ modulePath }) => modulePath === REQUEST_MIDDLEWARE_PATH)
  const referenceCount = kernel
    .getDescendants()
    .filter((node) => dynamicImportModule(node) === REQUEST_MIDDLEWARE_PATH).length
  return { safeMatches, referenceCount }
}

function middlewareIsFirst(stack: ArrayLiteralExpression) {
  const first = stack.getElements()[0]
  return first ? middlewareThunkModule(first) === REQUEST_MIDDLEWARE_PATH : false
}

function warnMiddleware(command: Configure) {
  command.logger.warning(
    'Periscope could not safely verify one standard inline request-watcher thunk. Keep exactly one direct () => import(...) thunk as the first server middleware in start/kernel.ts; request work before it cannot be correlated:'
  )
  command.logger.log(`() => import('${REQUEST_MIDDLEWARE_PATH}'),`)
}

async function moveRequestMiddlewareFirst(
  command: Configure,
  standard: StandardServerStack
): Promise<ConfigureOutcome | undefined> {
  const { safeMatches, referenceCount } = inspectRequestMiddleware(standard.kernel, standard.stack)
  if (referenceCount === 0) return
  if (referenceCount !== 1 || safeMatches.length !== 1) {
    warnMiddleware(command)
    return 'manual-action'
  }
  const match = safeMatches[0]
  if (match.index === 0) return 'already-configured'
  if (match.hasLeadingComments) {
    warnMiddleware(command)
    return 'manual-action'
  }

  const thunk = match.element.getText()
  standard.stack.removeElement(match.index)
  standard.stack.insertElement(0, thunk)
  await standard.kernel.save()
  return 'configured'
}

async function configureMiddleware(
  command: Configure,
  codemods: Codemods,
  project: Project
): Promise<ConfigureOutcome> {
  const standard = standardServerStack(project, command.app.startPath('kernel.ts'))
  if (!standard) {
    warnMiddleware(command)
    return 'manual-action'
  }

  const existing = await moveRequestMiddlewareFirst(command, standard)
  if (existing) return existing

  await codemods.registerMiddleware('server', [
    { path: REQUEST_MIDDLEWARE_PATH, position: 'before' },
  ])

  const updated = standardServerStack(project, command.app.startPath('kernel.ts'))
  if (!updated) {
    warnMiddleware(command)
    return 'manual-action'
  }
  const configured = await moveRequestMiddlewareFirst(command, updated)
  if (!configured || !middlewareIsFirst(updated.stack)) {
    warnMiddleware(command)
    return 'manual-action'
  }
  return 'configured'
}

/**
 * Resolve optional packages from the host application without evaluating their entrypoints.
 * Package initialization may be expensive, have side effects, or wait for application services that do
 * not exist while a configure hook is running.
 */
function packageIsAvailable(command: Configure, moduleId: string) {
  try {
    createRequire(command.app.makePath('package.json')).resolve(moduleId)
    return true
  } catch {
    return false
  }
}

function normalizeDashboardPath(path: string) {
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`
  if (withLeadingSlash === '/') return ''
  return withLeadingSlash.replace(/\/+$/, '')
}

function shieldMutationRoutes(dashboardPath: string) {
  const prefix = normalizeDashboardPath(dashboardPath)
  return [`${prefix}/api/flags/:name`, `${prefix}/api/clear`, `${prefix}/api/monitored-tags/:tag`]
}

function warnShield(command: Configure, dashboardPath: string) {
  const routes = shieldMutationRoutes(dashboardPath)
  command.logger.warning(
    'Shield is installed, but its exceptRoutes setting is not a standard array. Preserve the custom predicate, but ensure it returns false for every Periscope mutation route pattern below so Shield validates their CSRF tokens:'
  )
  command.logger.log(
    routes.map((route) => `ctx.route?.pattern === ${JSON.stringify(route)}`).join('\n')
  )
}

async function configureShield(
  command: Configure,
  project: Project,
  dashboardPath: string | undefined
): Promise<ConfigureOutcome> {
  if (!packageIsAvailable(command, '@adonisjs/shield')) return 'not-applicable'
  if (!dashboardPath) {
    command.logger.warning(
      'Shield is installed, but Periscope could not infer the dashboard path from the preserved config. Remove any Periscope flags, clear, and monitored-tag mutation patterns from csrf.exceptRoutes after resolving the dashboard path.'
    )
    return 'manual-action'
  }

  const file = sourceFile(project, command.app.configPath('shield.ts'))
  const config = file && defineConfigObject(file)
  const csrfProperty = config?.getProperty('csrf')
  let csrfInitializer
  if (csrfProperty?.getKindName() === 'PropertyAssignment') {
    const csrfAssignment = csrfProperty as PropertyAssignment
    csrfInitializer = csrfAssignment.getInitializer()
  }
  const csrf =
    csrfInitializer?.getKindName() === 'ObjectLiteralExpression'
      ? (csrfInitializer as ObjectLiteralExpression)
      : undefined
  if (!file || !csrf) {
    warnShield(command, dashboardPath)
    return 'manual-action'
  }

  const exceptRoutesProperty = csrf.getProperty('exceptRoutes')
  if (!exceptRoutesProperty) return 'already-configured'

  const exceptRoutes = arrayProperty(csrf, 'exceptRoutes')
  if (!exceptRoutes) {
    warnShield(command, dashboardPath)
    return 'manual-action'
  }

  const routes = shieldMutationRoutes(dashboardPath)
  const indexes: number[] = []
  exceptRoutes.getElements().forEach((element, index) => {
    if (
      element.getKindName() === 'StringLiteral' &&
      routes.includes((element as StringLiteral).getLiteralValue())
    ) {
      indexes.push(index)
    }
  })

  if (indexes.length === 0) return 'already-configured'
  indexes.reverse().forEach((index) => exceptRoutes.removeElement(index))
  await file.save()
  return 'configured'
}

function conciseDiff(before: string, after: string) {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const removed = beforeLines.filter((line) => !afterLines.includes(line))
  const added = afterLines.filter((line) => !beforeLines.includes(line))
  return [
    '--- app/exceptions/handler.ts',
    '+++ app/exceptions/handler.ts',
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
  ].join('\n')
}

function warnExceptionHandler(command: Configure, composedExpression?: string) {
  command.logger.warning(
    "Periscope left app/exceptions/handler.ts unchanged. Add the runtime import below, then keep the handler constructor locally named and replace its current default export with a wrapped one. For a default-exported class, give an anonymous class a name and remove the class's export default modifiers first:"
  )
  command.logger.log("import { withPeriscope } from 'adonisjs-periscope/exception_reporter'")
  command.logger.log(
    `export default withPeriscope(${composedExpression ?? 'HttpExceptionHandler'})`
  )
}

function reporterSpecifiers(file: SourceFile) {
  return file
    .getImportDeclarations()
    .filter(
      (declaration) =>
        declaration.getModuleSpecifierValue() === 'adonisjs-periscope/exception_reporter'
    )
    .flatMap((declaration) =>
      declaration
        .getNamedImports()
        .filter((specifier) => {
          return specifier.getName() === 'withPeriscope' && !specifier.getAliasNode()
        })
        .map((specifier) => ({ declaration, specifier }))
    )
}

function hasWithPeriscopeConflict(file: SourceFile) {
  const conflictingImport = file.getImportDeclarations().some((declaration) => {
    if (declaration.getDefaultImport()?.getText() === 'withPeriscope') return true
    if (declaration.getNamespaceImport()?.getText() === 'withPeriscope') return true
    return declaration.getNamedImports().some((specifier) => {
      const localName = specifier.getAliasNode()?.getText() ?? specifier.getName()
      const isExpectedReporterImport =
        declaration.getModuleSpecifierValue() === 'adonisjs-periscope/exception_reporter' &&
        specifier.getName() === 'withPeriscope' &&
        !specifier.getAliasNode()
      return localName === 'withPeriscope' && !isExpectedReporterImport
    })
  })
  return (
    conflictingImport ||
    !!file.getClass('withPeriscope') ||
    !!file.getFunction('withPeriscope') ||
    !!file.getVariableDeclaration('withPeriscope')
  )
}

function ensureRuntimeReporterImport(file: SourceFile) {
  const candidates = reporterSpecifiers(file)
  if (candidates.length > 1 || hasWithPeriscopeConflict(file)) return false

  const candidate = candidates[0]
  if (candidate && !candidate.declaration.isTypeOnly() && !candidate.specifier.isTypeOnly()) {
    return true
  }
  if (candidate?.declaration.isTypeOnly()) {
    if (
      candidate.declaration.getNamedImports().length === 1 &&
      !candidate.declaration.getDefaultImport() &&
      !candidate.declaration.getNamespaceImport()
    ) {
      candidate.declaration.setIsTypeOnly(false)
      return true
    }
    candidate.specifier.remove()
  } else if (candidate?.specifier.isTypeOnly()) {
    candidate.specifier.setIsTypeOnly(false)
    return true
  }

  const valueReporterImport = file.getImportDeclarations().find((declaration) => {
    return (
      declaration.getModuleSpecifierValue() === 'adonisjs-periscope/exception_reporter' &&
      !declaration.isTypeOnly() &&
      !declaration.getNamespaceImport()
    )
  })
  if (valueReporterImport) {
    valueReporterImport.addNamedImport('withPeriscope')
  } else {
    file.addImportDeclaration({
      moduleSpecifier: 'adonisjs-periscope/exception_reporter',
      namedImports: ['withPeriscope'],
    })
  }
  return true
}

async function configureExceptionHandler(
  command: Configure,
  project: Project
): Promise<ConfigureOutcome> {
  const file = sourceFile(project, command.app.exceptionsPath('handler.ts'))
  if (!file) {
    warnExceptionHandler(command)
    return 'manual-action'
  }

  const exportAssignments = file
    .getExportAssignments()
    .filter((assignment) => !assignment.isExportEquals())
  const defaultClasses = file.getClasses().filter((declaration) => declaration.hasDefaultKeyword())
  let defaultClass: ClassDeclaration | undefined
  const defaultExport = exportAssignments[0]
  let handlerName: string | undefined
  let alreadyWrapped = false

  if (exportAssignments.length === 1 && defaultClasses.length === 0) {
    const expression = defaultExport.getExpression()
    if (expression?.getKindName() === 'CallExpression') {
      const call = expression as CallExpression
      if (call.getExpression().getText() !== 'withPeriscope') {
        warnExceptionHandler(command, expression.getText())
        return 'manual-action'
      }
      alreadyWrapped = true
    } else if (expression?.getKindName() === 'Identifier') {
      handlerName = expression.getText()
      if (!file.getClass(handlerName)) {
        warnExceptionHandler(command)
        return 'manual-action'
      }
    } else {
      warnExceptionHandler(command)
      return 'manual-action'
    }
  } else if (exportAssignments.length === 0 && defaultClasses.length === 1) {
    defaultClass = defaultClasses[0]
    handlerName = defaultClass.getName()
    if (!handlerName) {
      warnExceptionHandler(command)
      return 'manual-action'
    }
  } else {
    warnExceptionHandler(command)
    return 'manual-action'
  }

  const imports = reporterSpecifiers(file)
  const hasRuntimeImport =
    imports.length === 1 &&
    !imports[0].declaration.isTypeOnly() &&
    !imports[0].specifier.isTypeOnly()
  if (alreadyWrapped && hasRuntimeImport) return 'already-configured'
  if (hasWithPeriscopeConflict(file) || imports.length > 1) {
    warnExceptionHandler(command)
    return 'manual-action'
  }

  const before = file.getFullText()
  if (!ensureRuntimeReporterImport(file)) {
    warnExceptionHandler(command)
    return 'manual-action'
  }
  if (!alreadyWrapped) {
    if (defaultClass) {
      defaultClass.setIsDefaultExport(false)
      file.addExportAssignment({
        isExportEquals: false,
        expression: `withPeriscope(${handlerName})`,
      })
    } else {
      defaultExport.setExpression(`withPeriscope(${handlerName})`)
    }
  }
  const after = file.getFullText()
  command.logger.log(conciseDiff(before, after))

  const confirmed = await command.prompt.confirm('Apply this exception handler change?', {
    default: true,
  })
  if (!confirmed) {
    file.replaceWithText(before)
    warnExceptionHandler(command)
    return 'manual-action'
  }

  await file.save()
  return 'configured'
}

function shellArgument(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function printChecklist(
  command: Configure,
  state: ConfigurationState,
  outcomes: {
    provider: ConfigureOutcome
    middleware: ConfigureOutcome
    shield: ConfigureOutcome
    exceptionHandler: ConfigureOutcome
    migration: ConfigureOutcome
  }
) {
  const complete = (outcome: ConfigureOutcome) =>
    outcome === 'configured' || outcome === 'already-configured' || outcome === 'not-applicable'
  command.logger.log('')
  command.logger.info('Periscope configuration checklist')
  command.logger.log(
    `${complete(outcomes.provider) ? '[x]' : '[ ]'} Keep the environment-scoped Periscope provider immediately after core app/hash providers`
  )
  command.logger.log(
    `${complete(outcomes.middleware) ? '[x]' : '[ ]'} Keep adonisjs-periscope/middleware/request_watcher first in server.use([...])`
  )
  command.logger.log(
    outcomes.shield === 'not-applicable'
      ? '[x] Shield is not installed; Periscope mutations require the dashboard-only request header'
      : `${complete(outcomes.shield) ? '[x]' : '[ ]'} Keep every Periscope mutation route under Shield CSRF verification`
  )
  command.logger.log(
    `${complete(outcomes.exceptionHandler) ? '[x]' : '[ ]'} Wrap the application exception handler with withPeriscope`
  )

  if (state.storageDriver === 'database') {
    const connection = state.connection
    const migrationCommand = connection
      ? `node ace migration:run --connection=${shellArgument(connection)}`
      : 'node ace migration:run'
    command.logger.log(
      `${complete(outcomes.migration) ? '[x]' : '[ ]'} Publish exactly one Periscope tables migration`
    )
    command.logger.log(`[ ] Run ${migrationCommand}`)
    command.logger.log(
      `[ ] Ensure connections.${connection ?? '<default>'} exists in config/database.ts and has debug: true so Lucid emits query events`
    )
    const connectionLiteral = JSON.stringify(connection ?? '<default connection name>')
    command.logger.log(
      `config/database.ts:\nconnections: {\n  ${connectionLiteral}: {\n    debug: true,\n    // keep the existing connection settings\n  },\n},`
    )
  } else if (!state.storageDriver) {
    command.logger.log(
      '[ ] Review the preserved config/periscope.ts storage settings and database prerequisites'
    )
  }

  command.logger.log(
    '[ ] Set debug: true on every Lucid connection whose application queries Periscope should record'
  )

  command.logger.log(
    "[ ] Optional: register periscopeDoctor() from 'adonisjs-periscope/hooks' in adonisrc.ts hooks.init to check Node, migrations, Lucid debug, dashboard routes, and middleware ordering"
  )
}

/**
 * Configure Periscope inside an AdonisJS v7 application.
 */
export async function configure(command: Configure) {
  const configPath = command.app.configPath('periscope.ts')
  const preserveConfig = !command.force && (await fileExists(configPath))
  let state: ConfigurationState

  if (preserveConfig) {
    state = inferConfiguration(await readFile(configPath, 'utf8'))
    command.logger.info('Preserving the existing config/periscope.ts file')
  } else {
    const selectedStorage = command.parsedFlags.storage
    let storageDriver: unknown = selectedStorage
    if (storageDriver === undefined) {
      storageDriver = await command.prompt.choice(
        'Where should Periscope store entries?',
        [
          { name: 'sqlite-local', message: 'Local SQLite file (recommended)' },
          { name: 'database', message: 'An existing Lucid database connection' },
        ],
        { default: 'sqlite-local' }
      )
    }
    if (storageDriver !== 'sqlite-local' && storageDriver !== 'database') {
      command.logger.error(
        `Invalid Periscope storage "${String(storageDriver)}". Select one from: sqlite-local, database`
      )
      command.exitCode = 1
      return
    }

    let connection: string | undefined
    if (storageDriver === 'database') {
      const selectedConnection = command.parsedFlags.connection
      const answer =
        selectedConnection === undefined
          ? await command.prompt.ask('Which Lucid connection should Periscope use?', {
              validate(value) {
                return value.trim().length > 0 || 'Enter a Lucid connection name'
              },
            })
          : selectedConnection
      if (typeof answer !== 'string' || answer.trim().length === 0) {
        command.logger.error('The Periscope database connection must be a non-empty string')
        command.exitCode = 1
        return
      }
      connection = answer.trim()
    }
    state = { storageDriver, connection, dashboardPath: DEFAULT_DASHBOARD_PATH }
  }

  const codemods = await command.createCodemods()
  let codemodFailed = false
  codemods.on('error', () => {
    codemodFailed = true
  })

  if (!preserveConfig) {
    await codemods.makeUsingStub(stubsRoot, 'config/periscope.stub', {
      storageDriver: state.storageDriver,
      connectionLiteral: state.connection ? JSON.stringify(state.connection) : undefined,
    })
  }

  let migration: ConfigureOutcome = 'not-applicable'
  if (state.storageDriver === 'database') {
    const migrationsPath = command.app.migrationsPath()
    if (await hasPeriscopeMigration(migrationsPath)) {
      migration = 'already-configured'
    } else {
      const generated = await codemods.makeUsingStub(
        stubsRoot,
        'migrations/create_periscope_tables.stub',
        {
          migrationFileName: `${Date.now()}_create_periscope_tables.ts`,
        }
      )
      migration = generated.status === 'skipped' ? 'manual-action' : 'configured'
    }
    if (!packageIsAvailable(command, '@adonisjs/lucid')) {
      command.logger.warning(
        'The database storage driver requires @adonisjs/lucid. Install and configure Lucid before running the Periscope migration.'
      )
    }
  }

  const project = await codemods.getTsMorphProject()
  const providerRegistration = project ? providerRegistrationKind(command, project) : 'missing'
  await codemods.updateRcFile((rcFile) => {
    if (providerRegistration !== 'custom') {
      rcFile.addProvider(PROVIDER_PATH, [...PROVIDER_ENVIRONMENTS])
    }
    rcFile.addCommand(COMMANDS_PATH)
  })

  let provider: ConfigureOutcome = 'manual-action'
  let middleware: ConfigureOutcome = 'manual-action'
  let shield: ConfigureOutcome = 'manual-action'
  let exceptionHandler: ConfigureOutcome = 'manual-action'

  if (!project) {
    warnProviderOrder(command)
    warnMiddleware(command)
    if (state.dashboardPath) warnShield(command, state.dashboardPath)
    warnExceptionHandler(command)
  } else {
    provider = await configureProviderOrder(command, project)
    middleware = await configureMiddleware(command, codemods, project)
    shield = await configureShield(command, project, state.dashboardPath)
    exceptionHandler = await configureExceptionHandler(command, project)
  }

  if (codemodFailed) {
    command.logger.warning(
      'One or more Adonis codemods reported an error. Review every unchecked item below before starting the application.'
    )
  }
  printChecklist(command, state, { provider, middleware, shield, exceptionHandler, migration })
}
