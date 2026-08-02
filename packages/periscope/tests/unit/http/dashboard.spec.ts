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
import {
  PERISCOPE_REQUEST_HEADER,
  PERISCOPE_REQUEST_HEADER_VALUE,
  protectDashboardMutation,
} from '../../../src/http/middleware/protect_mutations.ts'
import { registerDashboardRoutes } from '../../../src/http/routes.ts'
import { makeStoredEntry } from '../../storage/contract.ts'
import type { EntryQuery, ResolvedPeriscopeConfig } from '../../../src/types.ts'

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

  test('re-run dashboard authorization before opening an SSE connection', async ({ assert }) => {
    let authorizationCalls = 0
    let streamHandlerCalls = 0
    const config = defineConfig({
      storage: { driver: 'memory' },
      dashboard: {
        authorize: () => {
          authorizationCalls += 1
          return false
        },
      },
    })
    const recorder = createRecorder(config).recorder
    const context = createContext('/periscope/api/stream')

    await createDashboardAuthorize(config, recorder, {
      nodeEnv: 'development',
      periscopeEnabled: () => undefined,
    })(context, async () => {
      streamHandlerCalls += 1
    })

    assert.equal(context.response.getStatus(), 403)
    assert.equal(authorizationCalls, 1)
    assert.equal(streamHandlerCalls, 0)
  })

  test('deny production by default per application request and preserve custom overrides', async ({
    assert,
  }) => {
    const config = defineConfig({
      enabledIn: ['development', 'production'],
      storage: { driver: 'memory' },
    })
    const recorder = createRecorder(config).recorder
    const production = createContext('/periscope/api/status')
    production.containerResolver = {
      make: async () => ({ inProduction: true }),
    } as unknown as typeof production.containerResolver
    const development = createContext('/periscope/api/status')
    development.containerResolver = {
      make: async () => ({ inProduction: false }),
    } as unknown as typeof development.containerResolver
    let developmentNextCalls = 0

    await createDashboardAuthorize(config, recorder, {
      nodeEnv: 'production',
      periscopeEnabled: () => undefined,
    })(production, async () => {})
    await createDashboardAuthorize(config, recorder, {
      nodeEnv: 'development',
      periscopeEnabled: () => undefined,
    })(development, async () => {
      developmentNextCalls += 1
    })

    assert.equal(production.response.getStatus(), 403)
    assert.equal(developmentNextCalls, 1)

    const override = defineConfig({
      enabledIn: ['production'],
      storage: { driver: 'memory' },
      dashboard: { authorize: () => true },
    })
    const overrideContext = createContext('/periscope/api/status')
    let overrideNextCalls = 0
    await createDashboardAuthorize(override, createRecorder(override).recorder, {
      nodeEnv: 'production',
      periscopeEnabled: () => undefined,
    })(overrideContext, async () => {
      overrideNextCalls += 1
    })

    assert.equal(overrideNextCalls, 1)
  })
})

test.group('Dashboard mutation protection', () => {
  test('reject drive-by clear requests and allow the dashboard same-origin header', async ({
    assert,
  }) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const context = createContext('/periscope/api/clear', method)
      let nextCalls = 0

      await protectDashboardMutation(context, async () => {
        nextCalls += 1
      })

      assert.equal(context.response.getStatus(), 403, method)
      assert.equal(nextCalls, 0, method)
    }

    const allowed = createContext('/periscope/api/clear', 'POST')
    allowed.request.request.headers[PERISCOPE_REQUEST_HEADER] = PERISCOPE_REQUEST_HEADER_VALUE
    allowed.request.request.headers['sec-fetch-site'] = 'same-origin'
    let allowedNextCalls = 0

    await protectDashboardMutation(allowed, async () => {
      allowedNextCalls += 1
    })

    assert.equal(allowedNextCalls, 1)
  })

  test('reject same-site and cross-site mutation fetches even with the dashboard header', async ({
    assert,
  }) => {
    for (const fetchSite of ['same-site', 'cross-site']) {
      const context = createContext('/periscope/api/monitored-tags/slow', 'PUT')
      context.request.request.headers[PERISCOPE_REQUEST_HEADER] = PERISCOPE_REQUEST_HEADER_VALUE
      context.request.request.headers['sec-fetch-site'] = fetchSite
      let nextCalls = 0

      await protectDashboardMutation(context, async () => {
        nextCalls += 1
      })

      assert.equal(context.response.getStatus(), 403, fetchSite)
      assert.equal(nextCalls, 0, fetchSite)
    }
  })

  test('expose Shield request tokens without caching and degrade to the header fallback', ({
    assert,
  }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const { store } = createRecorder(config)
    const controller = new DashboardController(store, config, {
      nodeEnv: 'development',
      periscopeEnabled: () => undefined,
    })
    const withoutShield = createContext('/periscope/api/csrf-token')
    const withShield = createContext('/periscope/api/csrf-token')
    Object.assign(withShield.request, { csrfToken: 'shield-token' })

    assert.deepEqual(controller.csrfToken(withoutShield), { token: null })
    assert.deepEqual(controller.csrfToken(withShield), { token: 'shield-token' })
    assert.equal(withShield.response.getHeaders()['cache-control'], 'no-store')
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

    const exported = createContext('/periscope/api/batches/:batchId/export', 'GET', {
      batchId: query.batchId,
    })
    await controller.exportBatch(exported)
    assert.equal(
      exported.response.getHeaders()['content-disposition'],
      `attachment; filename="periscope-batch-${query.batchId}.json"`
    )
    assert.deepInclude(JSON.parse(exported.response.getBody()), {
      format: 'periscope.batch',
      version: 1,
      batchId: query.batchId,
      application: 'default',
    })
  })

  test('filter entry levels and allowlist list ordering query parameters', async ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const { store } = createRecorder(config)
    const oldest = makeStoredEntry({
      type: EntryType.LOG,
      content: { level: 'Info', message: 'oldest' },
    })
    const middle = makeStoredEntry({
      type: EntryType.LOG,
      content: { level: 'error', message: 'middle' },
    })
    const newest = makeStoredEntry({
      type: EntryType.LOG,
      content: { level: 'INFO', message: 'newest' },
    })
    await store.save([middle, newest, oldest])
    const controller = new EntriesController(store)

    const omitted = await controller.index(createContext('/periscope/api/entries'))
    const info = await controller.index(createContext('/periscope/api/entries?level=%20INFO%20'))
    const ascending = await controller.index(
      createContext('/periscope/api/entries?sort=sequence&direction=asc')
    )
    const invalid = await controller.index(
      createContext('/periscope/api/entries?sort=bogus&direction=sideways')
    )

    assert.deepEqual(
      omitted.data.map((entry) => entry.uuid),
      [newest.uuid, middle.uuid, oldest.uuid]
    )
    assert.deepEqual(
      info.data.map((entry) => entry.uuid),
      [newest.uuid, oldest.uuid]
    )
    assert.deepEqual(
      ascending.data.map((entry) => entry.uuid),
      [oldest.uuid, middle.uuid, newest.uuid]
    )
    assert.deepEqual(invalid, omitted)
  })

  test('pass tolerant list filters and ordering parameters to the store', async ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const { store } = createRecorder(config)
    const calls: EntryQuery[] = []
    const list = store.list.bind(store)
    store.list = async (query = {}) => {
      calls.push(query)
      return list(query)
    }
    const controller = new EntriesController(store)

    await controller.index(
      createContext(
        '/periscope/api/entries?tag=slow&tag=failed&text=Needle&from=2026-04-01T00%3A00%3A00.000Z&to=2026-04-02T00%3A00%3A00.000Z'
      )
    )
    await controller.index(
      createContext('/periscope/api/entries?from=not-a-date&to=2026-02-30T00%3A00%3A00.000Z')
    )
    await controller.index(
      createContext('/periscope/api/entries?level=%20INFO%20&sort=sequence&direction=asc')
    )
    await controller.index(
      createContext('/periscope/api/entries?level=%20%20&sort=bogus&direction=sideways')
    )

    assert.deepInclude(calls[0], {
      tags: ['slow', 'failed'],
      text: 'Needle',
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-02T00:00:00.000Z',
    })
    assert.isUndefined(calls[0].tag)
    assert.isUndefined(calls[1].from)
    assert.isUndefined(calls[1].to)
    assert.deepInclude(calls[2], { level: 'INFO', sort: 'sequence', direction: 'asc' })
    assert.isUndefined(calls[3].level)
    assert.isUndefined(calls[3].sort)
    assert.isUndefined(calls[3].direction)
  })

  test('serve only mail raw as a safely named EML attachment', async ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const { store } = createRecorder(config)
    const raw = 'From: sender@example.com\r\nSubject: Report\r\n\r\nHello'
    const mail = makeStoredEntry({
      type: EntryType.MAIL,
      content: { subject: 'Quarterly / report\r\n"draft".eml', raw },
    })
    const rejected = [
      makeStoredEntry({ type: EntryType.REQUEST, content: { raw } }),
      makeStoredEntry({ type: EntryType.MAIL, content: { raw: '' } }),
      makeStoredEntry({ type: EntryType.MAIL, content: { raw: ' \r\n\t' } }),
      makeStoredEntry({ type: EntryType.MAIL, content: { raw: 42 } }),
    ]
    await store.save([mail, ...rejected])
    const controller = new EntriesController(store)
    const context = createContext('/periscope/api/entries/:uuid/eml', 'GET', {
      uuid: mail.uuid,
    })

    await controller.eml(context)

    assert.equal(context.response.getStatus(), 200)
    assert.equal(context.response.getHeaders()['content-type'], 'message/rfc822')
    assert.equal(
      context.response.getHeaders()['content-disposition'],
      'attachment; filename="Quarterly - report-draft.eml"'
    )
    assert.equal(context.response.getBody(), raw)

    for (const entry of rejected) {
      const invalid = createContext('/periscope/api/entries/:uuid/eml', 'GET', {
        uuid: entry.uuid,
      })
      await controller.eml(invalid)
      assert.equal(invalid.response.getStatus(), 404)
    }

    const missing = createContext('/periscope/api/entries/:uuid/eml', 'GET', {
      uuid: 'missing',
    })
    await controller.eml(missing)
    assert.equal(missing.response.getStatus(), 404)
  })

  test('decode base64-backed raw MIME to lossless EML bytes', async ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const { store } = createRecorder(config)
    const raw = Buffer.concat([
      Buffer.from('Content-Type: text/plain; charset=ISO-8859-1\r\n\r\n'),
      Buffer.from([0xe9]),
    ])
    const mail = makeStoredEntry({
      type: EntryType.MAIL,
      content: {
        subject: 'Latin-1',
        raw: raw.toString('base64'),
        rawEncoding: 'base64',
      },
    })
    await store.save([mail])
    const controller = new EntriesController(store)
    const context = createContext('/periscope/api/entries/:uuid/eml', 'GET', {
      uuid: mail.uuid,
    })

    await controller.eml(context)

    assert.equal(context.response.getStatus(), 200)
    assert.equal(context.response.getHeaders()['content-type'], 'message/rfc822')
    assert.instanceOf(context.response.getBody(), Buffer)
    assert.deepEqual(context.response.getBody(), raw)
  })

  test('serve counts, status, well-known flags, and clear with the documented statuses', async ({
    assert,
  }) => {
    const config = defineConfig({
      storage: { driver: 'memory' },
      dashboard: { path: '/scope', nPlusOneThreshold: 7 },
    })
    const { store } = createRecorder(config)
    const entry = makeStoredEntry({ type: EntryType.REQUEST })
    await store.save([entry])
    const controller = new DashboardController(store, config, {
      nodeEnv: 'development',
      periscopeEnabled: () => undefined,
    })

    assert.deepEqual(await controller.counts(createContext('/scope/api/counts')), {
      data: { request: 1 },
    })
    assert.deepEqual(await controller.status(), {
      enabled: true,
      applicationName: 'default',
      applications: [
        {
          name: 'default',
          entries: 1,
          latestAt: entry.createdAt.toISOString(),
        },
      ],
      paused: false,
      path: '/scope',
      nPlusOneThreshold: 7,
    })

    const put = createContext('/scope/api/flags/paused', 'PUT', { name: Flag.PAUSED })
    put.request.updateBody({})
    await controller.setFlag(put)
    assert.equal(put.response.getStatus(), 204)
    assert.equal(await store.getFlag(Flag.PAUSED), '1')

    const remove = createContext('/scope/api/flags/paused', 'DELETE', { name: Flag.PAUSED })
    await controller.deleteFlag(remove)
    assert.equal(remove.response.getStatus(), 204)
    assert.isNull(await store.getFlag(Flag.PAUSED))

    const clear = createContext('/scope/api/clear', 'POST')
    await controller.clear(clear)
    assert.equal(clear.response.getStatus(), 204)
    assert.deepEqual(await store.counts(), {})
  })

  test('isolate expiring dump leases and reject unsafe flag names', async ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const { store } = createRecorder(config)
    const controller = new DashboardController(store, config, {
      nodeEnv: 'development',
      periscopeEnabled: () => undefined,
    })
    const expiries = new Map<string, Date | undefined>()
    const setFlag = store.setFlag.bind(store)
    store.setFlag = async (name, value, options) => {
      expiries.set(name, options?.expiresAt)
      await setFlag(name, value, options)
    }
    const firstName = `${Flag.DUMP_OPEN}:tab-a`
    const secondName = `${Flag.DUMP_OPEN}:tab-b`
    const beforeLease = Date.now()

    for (const name of [firstName, secondName]) {
      const put = createContext(`/scope/api/flags/${encodeURIComponent(name)}`, 'PUT', { name })
      put.request.updateBody({ value: 'visible' })
      await controller.setFlag(put)
      assert.equal(put.response.getStatus(), 204)
      assert.equal(await store.getFlag(name), 'visible')
      assert.instanceOf(expiries.get(name), Date)
      assert.isAtLeast(expiries.get(name)!.getTime(), beforeLease + 30_000)
      assert.isAtMost(expiries.get(name)!.getTime(), Date.now() + 30_000)
    }

    const removeFirst = createContext(
      `/scope/api/flags/${encodeURIComponent(firstName)}`,
      'DELETE',
      {
        name: firstName,
      }
    )
    await controller.deleteFlag(removeFirst)

    assert.equal(removeFirst.response.getStatus(), 204)
    assert.isNull(await store.getFlag(firstName))
    assert.equal(await store.getFlag(secondName), 'visible')

    const unsafeNames = [
      Flag.DUMP_OPEN,
      `${Flag.DUMP_OPEN}:`,
      `${Flag.DUMP_OPEN}:tab:other`,
      `${Flag.DUMP_OPEN}:tab%`,
      `${Flag.DUMP_OPEN}:tab/other`,
      `${Flag.DUMP_OPEN}:${'a'.repeat(129)}`,
      'unknown',
    ]

    for (const name of unsafeNames) {
      const put = createContext(`/scope/api/flags/${encodeURIComponent(name)}`, 'PUT', { name })
      put.request.updateBody({ value: 'x' })
      await controller.setFlag(put)
      assert.equal(put.response.getStatus(), 404)

      const remove = createContext(`/scope/api/flags/${encodeURIComponent(name)}`, 'DELETE', {
        name,
      })
      await controller.deleteFlag(remove)
      assert.equal(remove.response.getStatus(), 404)
    }
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
    assert.equal(
      router.match('/periscope/api/entries/mail-id/eml', 'GET', true)?.route.pattern,
      '/periscope/api/entries/:uuid/eml'
    )
    assert.equal(
      router.match('/periscope/api/csrf-token', 'GET', true)?.route.pattern,
      '/periscope/api/csrf-token'
    )
    assert.equal(
      router.match('/periscope/api/entries', 'HEAD', true)?.route.pattern,
      '/periscope/api/entries'
    )
    assert.equal(
      router.match('/periscope/api/batches/batch-id/export', 'HEAD', true)?.route.pattern,
      '/periscope/api/batches/:batchId/export'
    )
    assert.equal(
      router.match('/periscope/api/monitored-tags/slow', 'PUT', true)?.route.pattern,
      '/periscope/api/monitored-tags/:tag'
    )
    assert.equal(
      router.match('/periscope/api/monitored-tags/slow', 'DELETE', true)?.route.pattern,
      '/periscope/api/monitored-tags/:tag'
    )
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
