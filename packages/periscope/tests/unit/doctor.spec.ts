/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { fileURLToPath } from 'node:url'

import { test } from '@japa/runner'
import type { FileSystem } from '@japa/file-system'

import { periscopeDoctor } from '../../src/hooks/doctor.ts'

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

async function createHealthyFixture(fs: FileSystem) {
  await Promise.all([fs.mkdir('config'), fs.mkdir('start'), fs.mkdir('database/custom_migrations')])
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
    assert.equal(doctor.output[0].match(/\bPASS\b/g)?.length, 5)
    assert.include(doctor.output[0], 'Periscope migration found for "primary"')
    assert.include(doctor.output[0], 'first in server.use')
    assert.include(doctor.output[0], 'no collisions under /scope')
  })

  test('reports missing migration, disabled Lucid debug, route collision, and bad ordering', async ({
    assert,
    fs,
  }) => {
    await Promise.all([fs.mkdir('config'), fs.mkdir('start')])
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
    assert.equal(doctor.output[0].match(/\bWARN\b/g)?.length, 4)
    assert.include(doctor.output[0], 'config/periscope could not be loaded')
    assert.include(doctor.output[0], 'start/kernel is missing')
  })

  test('does nothing outside the development server', async ({ assert, fs }) => {
    const doctor = await runDoctor(fs, 'build')

    assert.lengthOf(doctor.output, 0)
    assert.isUndefined(doctor.routeCommit())
  })
})
