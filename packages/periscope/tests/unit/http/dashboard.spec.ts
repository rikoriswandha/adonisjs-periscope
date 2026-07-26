/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { resolve } from 'node:path'

import { test } from '@japa/runner'
import { HttpContextFactory, RouterFactory } from '@adonisjs/core/factories/http'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType, Flag } from '../../../src/types.ts'
import { DashboardController } from '../../../src/http/controllers/dashboard_controller.ts'
import { EntriesController } from '../../../src/http/controllers/entries_controller.ts'
import { ExceptionGroupsController } from '../../../src/http/controllers/exception_groups_controller.ts'
import {
  resolveStaticPath,
  StaticController,
} from '../../../src/http/controllers/static_controller.ts'
import { createDashboardAuthorize } from '../../../src/http/middleware/authorize.ts'
import { registerDashboardRoutes } from '../../../src/http/routes.ts'
import { makeStoredEntry } from '../../storage/contract.ts'
import type { ResolvedPeriscopeConfig } from '../../../src/types.ts'

function createRecorder(config: ResolvedPeriscopeConfig) {
  const store = new MemoryStore()
  const recorder = new Recorder({ config, store, enabled: true })

  return { recorder, store }
}

function createContext(url: string, method: string = 'GET', params: Record<string, unknown> = {}) {
  const ctx = new HttpContextFactory().merge({ url, method }).create()
  ctx.params = params
  ctx.route = { pattern: url, params } as unknown as typeof ctx.route
  return ctx
}

test.group('Dashboard authorization', () => {
  test('return 404 from the environment gate before invoking authorize', async ({ assert }) => {
    let authorizationCalls = 0
    const config = defineConfig({
      enabledIn: ['development'],
      storage: { driver: 'memory' },
      dashboard: {
        authorize: () => {
          authorizationCalls += 1
          return true
        },
      },
    })
    const { recorder } = createRecorder(config)
    const middleware = createDashboardAuthorize(config, recorder, {
      nodeEnv: 'production',
      periscopeEnabled: () => undefined,
    })
    const ctx = createContext('/periscope/api/status')
    let nextCalls = 0

    await middleware(ctx, async () => {
      nextCalls += 1
    })

    assert.equal(ctx.response.getStatus(), 404)
    assert.equal(authorizationCalls, 0)
    assert.equal(nextCalls, 0)
  })

  test('return 403 for a denied request and mute the complete allowed chain', async ({
    assert,
  }) => {
    let mutedDuringAuthorize = false
    const deniedConfig = defineConfig({
      storage: { driver: 'memory' },
      dashboard: { authorize: () => false },
    })
    const denied = createRecorder(deniedConfig).recorder
    const environment = { nodeEnv: 'development', periscopeEnabled: () => undefined }
    const deniedContext = createContext('/periscope/api/status')

    await createDashboardAuthorize(deniedConfig, denied, environment)(deniedContext, async () => {})
    assert.equal(deniedContext.response.getStatus(), 403)

    const allowedConfig = defineConfig({
      storage: { driver: 'memory' },
      dashboard: {
        authorize: () => {
          mutedDuringAuthorize = BatchScope.current()?.muted === true
          return true
        },
      },
    })
    const allowed = createRecorder(allowedConfig).recorder
    let mutedDuringHandler = false

    await createDashboardAuthorize(
      allowedConfig,
      allowed,
      environment
    )(createContext('/periscope/api/status'), async () => {
      mutedDuringHandler = BatchScope.current()?.muted === true
    })

    assert.isTrue(mutedDuringAuthorize)
    assert.isTrue(mutedDuringHandler)
  })
})

test.group('Dashboard JSON API', () => {
  test('filter and serialize entry pages, details, and empty batches', async ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const { store } = createRecorder(config)
    const query = makeStoredEntry({
      type: EntryType.QUERY,
      familyHash: 'family-a',
      tags: ['slow'],
      shouldDisplayOnIndex: true,
    })
    await store.save([query, makeStoredEntry({ type: EntryType.REQUEST })])
    const controller = new EntriesController(store)

    const page = await controller.index(
      createContext(
        '/periscope/api/entries?type=query&tag=slow&family_hash=family-a&display_on_index=true&limit=1'
      )
    )

    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].uuid, query.uuid)
    assert.equal(page.data[0].sequence, query.sequence.toString())
    assert.equal(page.data[0].createdAt, query.createdAt.toISOString())
    assert.doesNotThrow(() => JSON.stringify(page))

    const detail = await controller.show(
      createContext('/periscope/api/entries/:uuid', 'GET', { uuid: query.uuid })
    )
    assert.equal(detail?.data.uuid, query.uuid)
    assert.doesNotThrow(() => JSON.stringify(detail))

    const missing = createContext('/periscope/api/entries/:uuid', 'GET', { uuid: 'missing' })
    await controller.show(missing)
    assert.equal(missing.response.getStatus(), 404)

    const batch = await controller.batch(
      createContext('/periscope/api/batches/:batchId', 'GET', { batchId: 'missing' })
    )
    assert.deepEqual(batch, { data: [] })
  })

  test('serve counts, status, well-known flags, and clear with the documented statuses', async ({
    assert,
  }) => {
    const config = defineConfig({
      storage: { driver: 'memory' },
      dashboard: { path: '/scope', nPlusOneThreshold: 7 },
    })
    const { store } = createRecorder(config)
    await store.save([makeStoredEntry({ type: EntryType.REQUEST })])
    const controller = new DashboardController(store, config, {
      nodeEnv: 'development',
      periscopeEnabled: () => undefined,
    })

    assert.deepEqual(await controller.counts(), { data: { request: 1 } })
    assert.deepEqual(await controller.status(), {
      enabled: true,
      paused: false,
      path: '/scope',
      nPlusOneThreshold: 7,
    })

    const put = createContext('/scope/api/flags/paused', 'PUT', { name: Flag.PAUSED })
    put.request.updateBody({})
    await controller.setFlag(put)
    assert.equal(put.response.getStatus(), 204)
    assert.equal(await store.getFlag(Flag.PAUSED), '1')

    const unknown = createContext('/scope/api/flags/unknown', 'PUT', { name: 'unknown' })
    unknown.request.updateBody({ value: 'x' })
    await controller.setFlag(unknown)
    assert.equal(unknown.response.getStatus(), 404)

    const remove = createContext('/scope/api/flags/paused', 'DELETE', { name: Flag.PAUSED })
    await controller.deleteFlag(remove)
    assert.equal(remove.response.getStatus(), 204)
    assert.isNull(await store.getFlag(Flag.PAUSED))

    const clear = createContext('/scope/api/clear', 'POST')
    await controller.clear(clear)
    assert.equal(clear.response.getStatus(), 204)
    assert.deepEqual(await store.counts(), {})
  })

  test('parse exact tag filters and serialize grouped exceptions', async ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const { store } = createRecorder(config)
    const older = makeStoredEntry({
      type: EntryType.EXCEPTION,
      familyHash: 'boom',
      tags: ['tenant:42'],
    })
    const latest = makeStoredEntry({
      type: EntryType.EXCEPTION,
      familyHash: 'boom',
      tags: ['tenant:7'],
    })
    const prefixOnly = makeStoredEntry({
      type: EntryType.EXCEPTION,
      familyHash: 'other',
      tags: ['tenant'],
    })
    await store.save([older, latest, prefixOnly])
    const controller = new ExceptionGroupsController(store)

    const page = await controller.index(
      createContext('/periscope/api/exception-groups?tag=tenant%3A42&limit=10')
    )

    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].familyHash, 'boom')
    assert.equal(page.data[0].count, 1)
    assert.equal(page.data[0].latest.sequence, older.sequence.toString())
    assert.equal(page.data[0].lastSeen, older.createdAt.toISOString())
    assert.doesNotThrow(() => JSON.stringify(page))
  })
})

test.group('Dashboard static routes', () => {
  test('reject traversal and Windows-ambiguous path segments', ({ assert }) => {
    const root = '/tmp/periscope-dashboard/assets'

    assert.isNull(resolveStaticPath(root, ['..', 'secret.txt']))
    assert.isNull(resolveStaticPath(root, '%2e%2e/secret.txt'))
    assert.isNull(resolveStaticPath(root, '..\\secret.txt'))
    assert.isNull(resolveStaticPath(root, 'nested./asset.js'))
    assert.isNull(resolveStaticPath(root, 'nested%20/asset.js'))
    assert.isNull(resolveStaticPath(root, 'asset.js%2E'))
    assert.isNull(resolveStaticPath(root, 'asset.js%20'))
    assert.equal(resolveStaticPath(root, ['index-abcdefgh.js']), resolve(root, 'index-abcdefgh.js'))
  })

  test('redirect the bare root and apply static cache policy', ({ assert }) => {
    const root = '/tmp/periscope-dashboard'
    const controller = new StaticController({ dashboardPath: '/scope', dashboardRoot: root })
    const bare = createContext('/scope')

    controller.root(bare)
    assert.equal(bare.response.getStatus(), 302)
    assert.equal(bare.response.getHeaders().location, '/scope/')

    const index = createContext('/scope/')
    controller.root(index)
    assert.equal(index.response.getHeaders()['cache-control'], 'no-cache')
    assert.equal(index.response.lazyBody.fileToStream?.[0], resolve(root, 'index.html'))

    const asset = createContext('/scope/assets/index-abcdefgh.js', 'GET', {
      '*': ['index-abcdefgh.js'],
    })
    controller.asset(asset)
    assert.equal(
      asset.response.getHeaders()['cache-control'],
      'public, max-age=31536000, immutable'
    )

    const traversal = createContext('/scope/assets/%2e%2e/secret', 'GET', {
      '*': ['..', 'secret'],
    })
    controller.asset(traversal)
    assert.equal(traversal.response.getStatus(), 404)
  })

  test('route unknown API paths to 404 before the SPA fallback', ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const { recorder } = createRecorder(config)
    const router = new RouterFactory().create()

    registerDashboardRoutes({
      router,
      recorder,
      config,
      environment: { nodeEnv: 'development', periscopeEnabled: () => undefined },
      dashboardRoot: '/tmp/periscope-dashboard',
    })
    router.commit()

    const unknownApi = router.match('/periscope/api/not-real', 'GET', true)
    const spa = router.match('/periscope/queries', 'GET', true)

    assert.equal(unknownApi?.route.pattern, '/periscope/api/*')
    assert.equal(spa?.route.pattern, '/periscope/*')
  })

  test('register a root-mounted dashboard without double-slash routes', ({ assert }) => {
    const config = defineConfig({
      storage: { driver: 'memory' },
      dashboard: { path: '/' },
    })
    const { recorder } = createRecorder(config)
    const router = new RouterFactory().create()

    registerDashboardRoutes({
      router,
      recorder,
      config,
      environment: { nodeEnv: 'development', periscopeEnabled: () => undefined },
      dashboardRoot: '/tmp/periscope-dashboard',
    })
    router.commit()

    assert.equal(router.match('/api/status', 'GET', true)?.route.pattern, '/api/status')
  })
})
