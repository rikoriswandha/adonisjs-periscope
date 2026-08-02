/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { fileURLToPath } from 'node:url'

import { test } from '@japa/runner'
import type { FileSystem } from '@japa/file-system'

import { fixLucidDebugConfig, periscopeDoctor, runDoctorChecks } from '../../src/hooks/doctor.ts'

type RouteCommit = (parent: unknown, routes: unknown) => void | Promise<void>

async function runDoctor(fs: FileSystem, mode: unknown = 'hmr') {
  const output: string[] = []
  let routeCommit: RouteCommit | undefined
  const parent = {
    mode,
    cwdPath: fileURLToPath(fs.baseUrl),
    ui: {
      logger: {
        log(message: string) {
          output.push(message)
        },
      },
    },
  }
  const hooks = {
    add(event: string, handler: RouteCommit) {
      if (event === 'routesCommitted') routeCommit = handler
    },
  }

  await periscopeDoctor().run(parent, hooks)
  return { output, parent, routeCommit: () => routeCommit }
}

const HEALTHY_DASHBOARD_ROUTES = [
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/api/entries' },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/api/entries/:uuid' },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/api/entries/:uuid/eml' },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/api/batches/:batchId' },
  {
    domain: 'root',
    methods: ['GET', 'HEAD'],
    pattern: '/scope/api/batches/:batchId/export',
  },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/api/csrf-token' },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/api/counts' },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/api/stats' },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/api/status' },
  { domain: 'root', methods: ['PUT'], pattern: '/scope/api/flags/:name' },
  { domain: 'root', methods: ['DELETE'], pattern: '/scope/api/flags/:name' },
  { domain: 'root', methods: ['POST'], pattern: '/scope/api/clear' },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/api/exception-groups' },
  { domain: 'root', methods: ['GET'], pattern: '/scope/api/stream' },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/api/monitored-tags' },
  { domain: 'root', methods: ['PUT'], pattern: '/scope/api/monitored-tags/:tag' },
  { domain: 'root', methods: ['DELETE'], pattern: '/scope/api/monitored-tags/:tag' },
  {
    domain: 'root',
    methods: ['HEAD', 'OPTIONS', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    pattern: '/scope/api',
  },
  {
    domain: 'root',
    methods: ['HEAD', 'OPTIONS', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    pattern: '/scope/api/*',
  },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/assets/*' },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope' },
  { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/*' },
] as const

async function createIntegrationFixture(fs: FileSystem, withWrapper = true) {
  await fs.mkdir('app/exceptions')
  await Promise.all([
    fs.create('package.json', JSON.stringify({ dependencies: {} })),
    fs.create(
      'adonisrc.ts',
      `export default {
  providers: [
    () => import('@adonisjs/core/providers/app_provider'),
    {
      file: () => import('@rikology/adonisjs-periscope/provider'),
      environment: ['web', 'console', 'test'],
    },
    () => import('@adonisjs/lucid/database_provider'),
  ],
}
`
    ),
    fs.create(
      'app/exceptions/handler.ts',
      withWrapper
        ? `import { withPeriscope } from '@rikology/adonisjs-periscope/exception_reporter'
export default withPeriscope(class Handler {})
`
        : 'export default class Handler {}\\n'
    ),
  ])
}

async function createHealthyFixture(fs: FileSystem) {
  await Promise.all([fs.mkdir('config'), fs.mkdir('start'), fs.mkdir('database/custom_migrations')])
  await createIntegrationFixture(fs)
  await Promise.all([
    fs.create(
      'config/periscope.ts',
      `export default {
  storage: { driver: 'database', connection: 'primary' },
  watchers: { query: { enabled: true } },
  dashboard: { path: '/scope' },
}
`
    ),
    fs.create(
      'config/database.ts',
      `export default {
  connection: 'primary',
  connections: {
    primary: { debug: true, migrations: { paths: ['database/custom_migrations'] } },
  },
}
`
    ),
    fs.create(
      'start/kernel.ts',
      `import server from '@adonisjs/core/services/server'
server.use([
  () => import('@rikology/adonisjs-periscope/middleware/request_watcher'),
  () => import('@adonisjs/core/bodyparser_middleware'),
])
`
    ),
    fs.create(
      'database/custom_migrations/1710000000000_renamed.ts',
      `import { createPeriscopeTables } from '@rikology/adonisjs-periscope/storage_schema'
export default class Migration {
  up() { createPeriscopeTables(this.schema) }
}
`
    ),
  ])
}

test.group('Periscope doctor', () => {
  test('prints one passing table after Assembler commits routes', async ({ assert, fs }) => {
    await createHealthyFixture(fs)
    const doctor = await runDoctor(fs)

    assert.lengthOf(doctor.output, 0)
    const routeCommit = doctor.routeCommit()
    assert.isFunction(routeCommit)
    await routeCommit!(doctor.parent, { root: HEALTHY_DASHBOARD_ROUTES })

    assert.lengthOf(doctor.output, 1)
    assert.include(doctor.output[0], 'Periscope doctor')
    assert.equal(doctor.output[0].match(/\bPASS\b/g)?.length, 8)
    assert.include(doctor.output[0], 'Periscope migration found for "primary"')
    assert.include(doctor.output[0], 'first in server.use')
    assert.include(doctor.output[0], 'no collisions under /scope')
  })

  test('reports missing migration, disabled Lucid debug, route collision, and bad ordering', async ({
    assert,
    fs,
  }) => {
    await Promise.all([fs.mkdir('config'), fs.mkdir('start')])
    await createIntegrationFixture(fs)
    await Promise.all([
      fs.create(
        'config/periscope.ts',
        `export default {
  storage: { driver: 'database' },
  watchers: { query: { enabled: true } },
  dashboard: { path: '/scope' },
}
`
      ),
      fs.create(
        'config/database.ts',
        `export default {
  connection: 'primary',
  connections: { primary: { debug: false } },
}
`
      ),
      fs.create(
        'start/kernel.ts',
        `import server from '@adonisjs/core/services/server'
server.use([
  () => import('@adonisjs/core/bodyparser_middleware'),
  () => import('@rikology/adonisjs-periscope/middleware/request_watcher'),
])
`
      ),
    ])

    const doctor = await runDoctor(fs)
    await doctor.routeCommit()!(doctor.parent, {
      root: [
        ...HEALTHY_DASHBOARD_ROUTES,
        { domain: 'root', methods: ['GET', 'HEAD'], pattern: '/scope/api/status' },
      ],
    })

    const table = doctor.output[0]
    assert.equal(table.match(/\bFAIL\b/g)?.length, 4)
    assert.include(table, 'Periscope migration missing')
    assert.include(table, 'debug !== true: primary')
    assert.include(table, '1 colliding route(s)')
    assert.include(table, 'request watcher must be first')
  })

  test('never throws for malformed and missing host configuration', async ({ assert, fs }) => {
    await fs.mkdir('config')
    await fs.create('config/periscope.ts', 'export default { storage:')

    const doctor = await runDoctor(fs)
    assert.isUndefined(doctor.routeCommit())

    assert.lengthOf(doctor.output, 1)
    assert.equal(doctor.output[0].match(/\bWARN\b/g)?.length, 7)
    assert.include(doctor.output[0], 'config/periscope could not be loaded')
    assert.include(doctor.output[0], 'start/kernel is missing')
  })

  test('checks provider registration and exception wrapper integration', async ({ assert, fs }) => {
    await createHealthyFixture(fs)
    const appRoot = fileURLToPath(fs.baseUrl)
    const logger = { log: (_message: string) => undefined }

    const healthy = await runDoctorChecks({ appRoot, logger })
    assert.deepInclude(
      healthy.find(({ name }) => name === 'Provider'),
      { status: 'PASS' }
    )
    assert.deepInclude(
      healthy.find(({ name }) => name === 'Exception wrapper'),
      { status: 'PASS' }
    )

    await Promise.all([
      fs.create(
        'adonisrc.ts',
        `export default { providers: [() => import('@adonisjs/core/providers/app_provider')] }\n`
      ),
      fs.create('app/exceptions/handler.ts', 'export default class Handler {}\\n'),
    ])
    const incomplete = await runDoctorChecks({ appRoot, logger })
    assert.deepInclude(
      incomplete.find(({ name }) => name === 'Provider'),
      { status: 'FAIL' }
    )
    assert.deepInclude(
      incomplete.find(({ name }) => name === 'Exception wrapper'),
      { status: 'WARN' }
    )
  })

  test('fixes missing Lucid debug settings and is idempotent', async ({ assert, fs }) => {
    await fs.mkdir('config')
    await fs.create(
      'config/database.ts',
      `export default {
  connection: 'primary',
  connections: {
    primary: {
      client: 'sqlite3',
    },
  },
}
`
    )
    const appRoot = fileURLToPath(fs.baseUrl)

    const first = await fixLucidDebugConfig(appRoot)
    assert.deepEqual(first.changed, ['primary'])
    const fixed = await fs.contents('config/database.ts')
    assert.include(fixed, 'primary: {\n      debug: true,')

    const second = await fixLucidDebugConfig(appRoot)
    assert.deepEqual(second, { changed: [], skipped: ['primary'] })
    assert.strictEqual(await fs.contents('config/database.ts'), fixed)
  })

  test('refuses an ambiguous Lucid connection codemod', async ({ assert, fs }) => {
    await fs.mkdir('config')
    const source = `export default {
  connection: 'primary',
  connections: {
    primary: {},
    primary: {},
  },
}
`
    await fs.create('config/database.ts', source)

    const result = await fixLucidDebugConfig(fileURLToPath(fs.baseUrl))
    assert.isNotEmpty(result.warning)
    assert.deepEqual(result.changed, [])
    assert.strictEqual(await fs.contents('config/database.ts'), source)
  })

  test('does nothing outside the development server', async ({ assert, fs }) => {
    const doctor = await runDoctor(fs, 'build')

    assert.lengthOf(doctor.output, 0)
    assert.isUndefined(doctor.routeCommit())
  })
})
