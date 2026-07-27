/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'
import { cliui } from '@poppinss/cliui'
import { Codemods } from '@adonisjs/core/ace/codemods'
import type Configure from '@adonisjs/core/commands/configure'
import type { FileSystem } from '@japa/file-system'

import { configure } from '../../configure.ts'
import { configure as rootConfigure, stubsRoot } from '../../src/index.ts'
import { createApp } from '../helpers/app_factory.ts'

const ADONIS_RC = `import { defineConfig } from '@adonisjs/core/app'

export default defineConfig({
  commands: [() => import('@adonisjs/core/commands')],
  providers: [
    () => import('@adonisjs/core/providers/app_provider'),
    () => import('@adonisjs/core/providers/hash_provider'),
    () => import('@adonisjs/lucid/database_provider'),
  ],
})
`

const KERNEL = `import server from '@adonisjs/core/services/server'

server.use([
  () => import('@adonisjs/core/bodyparser_middleware'),
])
`

const SHIELD = `import { defineConfig } from '@adonisjs/shield'

export default defineConfig({
  csrf: {
    enabled: true,
    exceptRoutes: ['/health'],
  },
})
`

const HANDLER = `import app from '@adonisjs/core/services/app'
import { ExceptionHandler } from '@adonisjs/core/http'

class HttpExceptionHandler extends ExceptionHandler {
  protected debug = !app.inProduction
}

export default HttpExceptionHandler
`

async function createFixture(fs: FileSystem) {
  await Promise.all([
    fs.mkdir('start'),
    fs.mkdir('config'),
    fs.mkdir('app/exceptions'),
    fs.mkdir('database/migrations'),
  ])
  await Promise.all([
    fs.create(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noResolve: true,
        },
        files: ['adonisrc.ts', 'start/kernel.ts', 'config/shield.ts', 'app/exceptions/handler.ts'],
      })
    ),
    fs.create('adonisrc.ts', ADONIS_RC),
    fs.create('start/kernel.ts', KERNEL),
    fs.create('config/shield.ts', SHIELD),
    fs.create('app/exceptions/handler.ts', HANDLER),
  ])
}

function count(source: string, value: string) {
  return source.split(value).length - 1
}

async function makeCommand(
  fs: FileSystem,
  options: {
    flags?: Record<string, unknown>
    storageAnswer?: 'sqlite-local' | 'database'
    connectionAnswer?: string
    confirmException?: boolean
    force?: boolean
  } = {}
) {
  const { app } = await createApp({ appRoot: fs.baseUrl })
  const evaluatedModules: string[] = []
  app.import = async (moduleId: string) => {
    evaluatedModules.push(moduleId)
    throw new Error(`Configure evaluated ${moduleId} while checking whether it is installed`)
  }
  const ui = cliui({ mode: 'raw' })
  const codemods = new Codemods(app, ui.logger)
  codemods.overwriteExisting = options.force === true
  const promptCalls = { choice: 0, ask: 0, confirm: 0 }
  const commandValue = {
    app,
    logger: ui.logger,
    force: options.force,
    parsedFlags: options.flags ?? {},
    prompt: {
      async choice() {
        promptCalls.choice++
        return options.storageAnswer ?? 'sqlite-local'
      },
      async ask() {
        promptCalls.ask++
        return options.connectionAnswer ?? 'primary'
      },
      async confirm() {
        promptCalls.confirm++
        return options.confirmException ?? true
      },
    },
    async createCodemods() {
      return codemods
    },
  }
  const command = commandValue as unknown as Configure
  return { command, promptCalls, evaluatedModules, ui }
}

test.group('Configure', () => {
  test('exports the named v7 hook and stubs root from the package root', ({ assert }) => {
    assert.strictEqual(rootConfigure, configure)
    assert.isString(stubsRoot)
    assert.isTrue(stubsRoot.endsWith('/stubs'))
  })

  test('configures the default sqlite-local installation and is idempotent', async ({
    assert,
    fs,
  }) => {
    await createFixture(fs)
    const first = await makeCommand(fs)

    await configure(first.command)

    const config = await fs.contents('config/periscope.ts')
    const rcFile = await fs.contents('adonisrc.ts')
    const kernel = await fs.contents('start/kernel.ts')
    const shield = await fs.contents('config/shield.ts')
    const handler = await fs.contents('app/exceptions/handler.ts')

    assert.include(config, "driver: 'sqlite-local'")
    assert.notInclude(config, 'connection: "')
    assert.lengthOf(await fs.readDir('database/migrations'), 0)
    assert.equal(count(rcFile, "import('periscope/provider')"), 1)
    assert.equal(count(rcFile, "import('periscope/commands')"), 1)
    assert.include(rcFile, "environment: ['web', 'console', 'test']")
    assert.isBelow(
      rcFile.indexOf("import('periscope/provider')"),
      rcFile.indexOf("import('@adonisjs/lucid/database_provider')")
    )
    assert.match(
      kernel,
      /server\.use\(\[\s*\(\) => import\('periscope\/middleware\/request_watcher'\)/
    )
    assert.equal(count(shield, '/periscope/api/flags/:name'), 1)
    assert.equal(count(shield, '/periscope/api/clear'), 1)
    assert.notInclude(shield, '/periscope/*')
    assert.equal(count(handler, "from 'periscope/exception_reporter'"), 1)
    assert.equal(count(handler, 'export default withPeriscope(HttpExceptionHandler)'), 1)
    assert.equal(first.promptCalls.choice, 1)
    assert.equal(first.promptCalls.confirm, 1)
    assert.deepEqual(first.evaluatedModules, [])
    assert.isTrue(
      first.ui.logger.getLogs().some((log) => log.message.includes('--- app/exceptions/handler.ts'))
    )
    assert.isTrue(
      first.ui.logger
        .getLogs()
        .some((log) =>
          log.message.includes(
            'debug: true on every Lucid connection whose application queries Periscope should record'
          )
        )
    )

    const second = await makeCommand(fs, { storageAnswer: 'database', confirmException: false })
    await configure(second.command)

    const rerunConfig = await fs.contents('config/periscope.ts')
    const rerunRcFile = await fs.contents('adonisrc.ts')
    const rerunKernel = await fs.contents('start/kernel.ts')
    const rerunShield = await fs.contents('config/shield.ts')
    const rerunHandler = await fs.contents('app/exceptions/handler.ts')
    assert.strictEqual(rerunConfig, config)
    assert.equal(count(rerunRcFile, "import('periscope/provider')"), 1)
    assert.equal(count(rerunRcFile, "import('periscope/commands')"), 1)
    assert.equal(count(rerunKernel, "import('periscope/middleware/request_watcher')"), 1)
    assert.equal(count(rerunShield, '/periscope/api/flags/:name'), 1)
    assert.equal(count(rerunShield, '/periscope/api/clear'), 1)
    assert.strictEqual(rerunHandler, handler)
    assert.deepEqual(second.promptCalls, { choice: 0, ask: 0, confirm: 0 })
    assert.deepEqual(second.evaluatedModules, [])
  }).timeout(10_000)

  test('shows the exception diff and leaves the handler untouched when declined', async ({
    assert,
    fs,
  }) => {
    await createFixture(fs)
    await fs.create(
      'config/periscope.ts',
      `export default {
  storage: {
    driver: 'sqlite-local',
  },
}
`
    )
    const invocation = await makeCommand(fs, { confirmException: false })

    await configure(invocation.command)

    assert.strictEqual(await fs.contents('app/exceptions/handler.ts'), HANDLER)
    assert.equal(invocation.promptCalls.confirm, 1)
    const logs = invocation.ui.logger
      .getLogs()
      .map((log) => log.message)
      .join('\n')
    assert.include(logs, '--- app/exceptions/handler.ts')
    assert.include(logs, "import { withPeriscope } from 'periscope/exception_reporter'")
    assert.include(logs, 'export default withPeriscope(HttpExceptionHandler)')
  })

  test('generates database state safely and never publishes a second migration', async ({
    assert,
    fs,
  }) => {
    await createFixture(fs)
    const first = await makeCommand(fs, {
      flags: { storage: 'database', connection: "tenant'west" },
    })

    await configure(first.command)

    const config = await fs.contents('config/periscope.ts')
    const migrationEntries = await fs.readDir('database/migrations')
    const migrations = migrationEntries.filter((entry) =>
      entry.basename.endsWith('_create_periscope_tables.ts')
    )
    assert.include(config, "driver: 'database'")
    assert.include(config, `connection: "tenant'west"`)
    assert.lengthOf(migrations, 1)
    const migration = await fs.contents(`database/migrations/${migrations[0].basename}`)
    assert.include(migration, 'createPeriscopeTables(this.schema)')
    assert.include(migration, 'dropPeriscopeTables(this.schema)')
    assert.deepEqual(first.evaluatedModules, [])

    const second = await makeCommand(fs, {
      flags: { storage: 'database', connection: "tenant'west" },
      force: true,
    })
    await configure(second.command)

    const rerunMigrationEntries = await fs.readDir('database/migrations')
    const rerunMigrations = rerunMigrationEntries.filter((entry) =>
      entry.basename.endsWith('_create_periscope_tables.ts')
    )
    assert.lengthOf(rerunMigrations, 1)
    assert.isTrue(
      second.ui.logger
        .getLogs()
        .some((log) => log.message.includes("migration:run --connection='tenant'\\''west'"))
    )
    assert.isTrue(second.ui.logger.getLogs().some((log) => log.message.includes('debug: true')))
    assert.deepEqual(second.evaluatedModules, [])
  }).timeout(10_000)

  test('preserves custom integration files and prints exact manual fallbacks', async ({
    assert,
    fs,
  }) => {
    await createFixture(fs)
    const customRc = `import { defineConfig } from '@adonisjs/core/app'
const periscopeProvider = () => import('periscope/provider')
export default defineConfig({
  providers: [() => import('@adonisjs/core/providers/app_provider'), periscopeProvider],
})
`
    const customKernel = `import server from '@adonisjs/core/services/server'
const serverMiddleware = [() => import('@adonisjs/core/bodyparser_middleware')]
server.use(serverMiddleware)
`
    const customShield = `import { defineConfig } from '@adonisjs/shield'
export default defineConfig({
  csrf: { enabled: true, exceptRoutes: (ctx) => ctx.request.url().startsWith('/internal') },
})
`
    const customHandler = `import { compose } from '@adonisjs/core/helpers'
import { ExceptionHandler } from '@adonisjs/core/http'
class HttpExceptionHandler extends ExceptionHandler {}
export default compose(HttpExceptionHandler)
`
    await Promise.all([
      fs.create('adonisrc.ts', customRc),
      fs.create('start/kernel.ts', customKernel),
      fs.create('config/shield.ts', customShield),
      fs.create('app/exceptions/handler.ts', customHandler),
      fs.create(
        'config/periscope.ts',
        `export default {
  storage: {
    driver: 'sqlite-local',
  },
  dashboard: {
    path: '/scope',
  },
}
`
      ),
    ])
    const invocation = await makeCommand(fs)

    await configure(invocation.command)

    const rcFile = await fs.contents('adonisrc.ts')
    assert.equal(count(rcFile, "import('periscope/provider')"), 1)
    assert.equal(count(rcFile, "import('periscope/commands')"), 1)
    assert.strictEqual(await fs.contents('start/kernel.ts'), customKernel)
    assert.strictEqual(await fs.contents('config/shield.ts'), customShield)
    assert.strictEqual(await fs.contents('app/exceptions/handler.ts'), customHandler)
    assert.deepEqual(invocation.promptCalls, { choice: 0, ask: 0, confirm: 0 })

    const logs = invocation.ui.logger
      .getLogs()
      .map((log) => log.message)
      .join('\n')
    assert.include(logs, "() => import('periscope/middleware/request_watcher')")
    assert.include(logs, `ctx.route?.pattern === "/scope/api/flags/:name"`)
    assert.include(logs, `ctx.route?.pattern === "/scope/api/clear"`)
    assert.include(logs, "import { withPeriscope } from 'periscope/exception_reporter'")
    assert.include(logs, 'export default withPeriscope(compose(HttpExceptionHandler))')
    assert.include(logs, "environment: ['web', 'console', 'test']")
  })

  test('wraps the official named default handler class and is idempotent', async ({
    assert,
    fs,
  }) => {
    await createFixture(fs)
    await Promise.all([
      fs.create(
        'config/periscope.ts',
        `export default {
  storage: { driver: 'sqlite-local' },
}
`
      ),
      fs.create(
        'app/exceptions/handler.ts',
        `import { ExceptionHandler } from '@adonisjs/core/http'

export default class HttpExceptionHandler extends ExceptionHandler {}
`
      ),
    ])
    const first = await makeCommand(fs)

    await configure(first.command)

    const handler = await fs.contents('app/exceptions/handler.ts')
    assert.notInclude(handler, 'export default class HttpExceptionHandler')
    assert.include(handler, 'class HttpExceptionHandler extends ExceptionHandler')
    assert.equal(count(handler, "from 'periscope/exception_reporter'"), 1)
    assert.equal(count(handler, 'export default withPeriscope(HttpExceptionHandler)'), 1)
    assert.equal(first.promptCalls.confirm, 1)
    assert.isTrue(
      first.ui.logger.getLogs().some((log) => log.message.includes('--- app/exceptions/handler.ts'))
    )

    const second = await makeCommand(fs, { confirmException: false })
    await configure(second.command)

    assert.strictEqual(await fs.contents('app/exceptions/handler.ts'), handler)
    assert.equal(second.promptCalls.confirm, 0)

    const anonymousHandler = `import { ExceptionHandler } from '@adonisjs/core/http'
export default class extends ExceptionHandler {}
`
    await fs.create('app/exceptions/handler.ts', anonymousHandler)
    const anonymous = await makeCommand(fs)
    await configure(anonymous.command)

    assert.strictEqual(await fs.contents('app/exceptions/handler.ts'), anonymousHandler)
    assert.equal(anonymous.promptCalls.confirm, 0)
    assert.isTrue(
      anonymous.ui.logger
        .getLogs()
        .some((log) => log.message.includes('give an anonymous class a name'))
    )
  }).timeout(10_000)

  test('moves one existing request watcher without duplication and warns on unsafe shapes', async ({
    assert,
    fs,
  }) => {
    await createFixture(fs)
    await fs.create(
      'config/periscope.ts',
      `export default {
  storage: { driver: 'sqlite-local' },
}
`
    )
    await fs.create(
      'start/kernel.ts',
      `import server from '@adonisjs/core/services/server'

server.use([
  () => import("@adonisjs/core/bodyparser_middleware"),
  () => import("periscope/middleware/request_watcher"),
])
`
    )
    const first = await makeCommand(fs)

    await configure(first.command)

    const reordered = await fs.contents('start/kernel.ts')
    assert.equal(count(reordered, 'periscope/middleware/request_watcher'), 1)
    assert.isBelow(
      reordered.indexOf('periscope/middleware/request_watcher'),
      reordered.indexOf('@adonisjs/core/bodyparser_middleware')
    )

    const second = await makeCommand(fs)
    await configure(second.command)
    assert.strictEqual(await fs.contents('start/kernel.ts'), reordered)

    const duplicateKernel = `import server from '@adonisjs/core/services/server'

server.use([
  () => import('periscope/middleware/request_watcher'),
  () => import("periscope/middleware/request_watcher"),
])
`
    await fs.create('start/kernel.ts', duplicateKernel)
    const duplicate = await makeCommand(fs)
    await configure(duplicate.command)
    assert.strictEqual(await fs.contents('start/kernel.ts'), duplicateKernel)
    assert.isTrue(
      duplicate.ui.logger
        .getLogs()
        .some((log) => log.message.includes('exactly one direct () => import(...) thunk'))
    )

    const customKernel = `import server from '@adonisjs/core/services/server'
const enabled = true

server.use([
  () => enabled ? import('periscope/middleware/request_watcher') : import('@adonisjs/core/bodyparser_middleware'),
])
`
    await fs.create('start/kernel.ts', customKernel)
    const custom = await makeCommand(fs)
    await configure(custom.command)
    assert.strictEqual(await fs.contents('start/kernel.ts'), customKernel)
  }).timeout(10_000)

  test('infers preserved config blocks independently of property order and keeps dynamic fallback', async ({
    assert,
    fs,
  }) => {
    await createFixture(fs)
    await fs.create(
      'config/periscope.ts',
      `export default {
  dashboard: {
    path: '/scope',
  },
  storage: {
    connection: 'primary',
    driver: 'database',
  },
}
`
    )
    const structural = await makeCommand(fs)

    await configure(structural.command)

    const migrationEntries = await fs.readDir('database/migrations')
    const migrations = migrationEntries.filter((entry) =>
      entry.basename.endsWith('_create_periscope_tables.ts')
    )
    assert.lengthOf(migrations, 1)
    const shield = await fs.contents('config/shield.ts')
    assert.include(shield, '/scope/api/flags/:name')
    assert.include(shield, '/scope/api/clear')
    assert.deepEqual(structural.promptCalls, { choice: 0, ask: 0, confirm: 1 })

    await Promise.all([
      fs.create('config/shield.ts', SHIELD),
      fs.create(
        'config/periscope.ts',
        `export default {
  dashboard: {
    path: env.get('PERISCOPE_PATH'),
  },
  storage: {
    driver: 'database',
    connection: env.get('DB_CONNECTION'),
  },
}
`
      ),
    ])
    const dynamic = await makeCommand(fs)
    await configure(dynamic.command)

    assert.deepEqual(dynamic.promptCalls, { choice: 0, ask: 0, confirm: 0 })
    assert.isTrue(
      dynamic.ui.logger
        .getLogs()
        .some((log) => log.message.includes('could not infer the dashboard path'))
    )
  }).timeout(10_000)

  test('converts declaration and specifier type-only reporter imports to runtime bindings', async ({
    assert,
    fs,
  }) => {
    await createFixture(fs)
    await fs.create(
      'config/periscope.ts',
      `export default {
  storage: { driver: 'sqlite-local' },
}
`
    )
    await fs.create(
      'app/exceptions/handler.ts',
      `import { ExceptionHandler } from '@adonisjs/core/http'
import type { withPeriscope } from 'periscope/exception_reporter'

class HttpExceptionHandler extends ExceptionHandler {}
export default HttpExceptionHandler
`
    )
    const declarationTypeOnly = await makeCommand(fs)

    await configure(declarationTypeOnly.command)

    const declarationResult = await fs.contents('app/exceptions/handler.ts')
    assert.notInclude(declarationResult, 'import type { withPeriscope }')
    assert.include(
      declarationResult,
      "import { withPeriscope } from 'periscope/exception_reporter'"
    )
    assert.include(declarationResult, 'export default withPeriscope(HttpExceptionHandler)')

    const declarationRerun = await makeCommand(fs, { confirmException: false })
    await configure(declarationRerun.command)
    assert.strictEqual(await fs.contents('app/exceptions/handler.ts'), declarationResult)
    assert.equal(declarationRerun.promptCalls.confirm, 0)

    await fs.create(
      'app/exceptions/handler.ts',
      `import { ExceptionHandler } from '@adonisjs/core/http'
import { type withPeriscope } from 'periscope/exception_reporter'

class HttpExceptionHandler extends ExceptionHandler {}
export default HttpExceptionHandler
`
    )
    const specifierTypeOnly = await makeCommand(fs)
    await configure(specifierTypeOnly.command)

    const specifierResult = await fs.contents('app/exceptions/handler.ts')
    assert.notInclude(specifierResult, 'type withPeriscope')
    assert.include(specifierResult, 'withPeriscope')
    assert.include(specifierResult, 'export default withPeriscope(HttpExceptionHandler)')

    const specifierRerun = await makeCommand(fs, { confirmException: false })
    await configure(specifierRerun.command)
    assert.strictEqual(await fs.contents('app/exceptions/handler.ts'), specifierResult)
    assert.equal(specifierRerun.promptCalls.confirm, 0)
  }).timeout(10_000)
})
