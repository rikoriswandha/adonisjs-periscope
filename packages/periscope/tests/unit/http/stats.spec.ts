/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'
import { HttpContextFactory, RouterFactory } from '@adonisjs/core/factories/http'

import { defineConfig } from '../../../src/define_config.ts'
import { DashboardController } from '../../../src/http/controllers/dashboard_controller.ts'
import { registerDashboardRoutes } from '../../../src/http/routes.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import type { EntryQuery, RequestStatsQuery } from '../../../src/types.ts'
import { makeStoredEntry } from '../../storage/contract.ts'

function createContext(url: string) {
  const context = new HttpContextFactory().merge({ url, method: 'GET' }).create()
  context.route = { pattern: url, params: {} } as unknown as typeof context.route
  return context
}

function createController(store: MemoryStore) {
  return new DashboardController(store, defineConfig({ storage: { driver: 'memory' } }), {
    nodeEnv: 'development',
    periscopeEnabled: () => undefined,
  })
}

test.group('Dashboard stats API', () => {
  test('computes bounded application-scoped request and slow-query statistics', async ({
    assert,
  }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const store = new MemoryStore()
    await store.save([
      ...[10, 20, 30, 100].map((durationMs, index) =>
        makeStoredEntry({
          application: 'shop',
          type: EntryType.REQUEST,
          content: { durationMs, status: index >= 2 ? 500 : 200 },
        })
      ),
      makeStoredEntry({
        application: 'other',
        type: EntryType.REQUEST,
        content: { durationMs: 999, status: 503 },
      }),
      makeStoredEntry({
        application: 'shop',
        type: EntryType.QUERY,
        familyHash: 'users-by-id',
        tags: ['slow'],
        content: { sql: 'select * from users where id = ?', durationMs: 40 },
      }),
      makeStoredEntry({
        application: 'shop',
        type: EntryType.QUERY,
        familyHash: 'users-by-id',
        tags: ['slow'],
        content: { sql: 'select * from users where id = ?', durationMs: 60 },
      }),
      makeStoredEntry({
        application: 'shop',
        type: EntryType.QUERY,
        familyHash: 'recent-orders',
        tags: ['slow'],
        content: { sql: 'select * from orders order by created_at desc', durationMs: 75 },
      }),
      makeStoredEntry({
        application: 'shop',
        type: EntryType.QUERY,
        familyHash: 'not-slow',
        content: { sql: 'select 1', durationMs: 1 },
      }),
    ])

    const listQueries: EntryQuery[] = []
    const originalList = store.list.bind(store)
    store.list = async (query) => {
      listQueries.push(query ?? {})
      return originalList(query)
    }
    const controller = new DashboardController(store, config, {
      nodeEnv: 'development',
      periscopeEnabled: () => undefined,
    })
    const context = createContext('/periscope/api/stats?application=shop')

    const result = await controller.stats(context)

    assert.deepEqual(listQueries, [
      { type: 'request', application: 'shop', limit: 500 },
      { type: 'query', tag: 'slow', application: 'shop', limit: 500 },
    ])
    assert.deepEqual(result, {
      data: {
        requests: { sampled: 4, errorCount: 2, p50: 20, p95: 100 },
        slowQueryFamilies: [
          {
            familyHash: 'users-by-id',
            sql: 'select * from users where id = ?',
            count: 2,
            avgDurationMs: 50,
            maxDurationMs: 60,
          },
          {
            familyHash: 'recent-orders',
            sql: 'select * from orders order by created_at desc',
            count: 1,
            avgDurationMs: 75,
            maxDurationMs: 75,
          },
        ],
      },
    })
    assert.equal(context.response.getHeaders()['cache-control'], 'no-store')
  })

  test('returns bucketed request statistics with the resolved analytics window', async ({
    assert,
  }) => {
    const store = new MemoryStore()
    const from = '2026-05-01T12:00:05.000Z'
    const to = '2026-05-01T12:00:24.000Z'
    await store.save([
      makeStoredEntry({
        application: 'shop',
        createdAt: new Date('2026-05-01T12:00:06.000Z'),
        content: {
          method: 'GET',
          url: '/users/1',
          routePattern: '/users/:id',
          status: 200,
          durationMs: 10,
        },
      }),
      makeStoredEntry({
        application: 'shop',
        createdAt: new Date('2026-05-01T12:00:16.000Z'),
        content: {
          method: 'GET',
          url: '/users/2',
          routePattern: '/users/:id',
          status: 500,
          durationMs: 30,
        },
      }),
      makeStoredEntry({
        application: 'other',
        createdAt: new Date('2026-05-01T12:00:16.000Z'),
        content: { method: 'GET', url: '/foreign', status: 503, durationMs: 999 },
      }),
    ])
    const context = createContext(
      `/periscope/api/stats?application=shop&bucket=10&group_by=route&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    )

    const result = await createController(store).stats(context)

    assert.deepEqual(result, {
      data: {
        from,
        to,
        bucketSeconds: 10,
        groupBy: 'route',
        buckets: [
          {
            bucketStart: from,
            group: 'GET /users/:id',
            count: 1,
            errorCount: 0,
            p50: 10,
            p95: 10,
          },
          {
            bucketStart: '2026-05-01T12:00:15.000Z',
            group: 'GET /users/:id',
            count: 1,
            errorCount: 1,
            p50: 30,
            p95: 30,
          },
        ],
        sampled: 2,
        truncated: false,
      },
    })
    assert.equal(context.response.getHeaders()['cache-control'], 'no-store')
  })

  test('applies a sixty-bucket default window when only bucket is supplied', async ({ assert }) => {
    const store = new MemoryStore()
    const queries: RequestStatsQuery[] = []
    const originalRequestStats = store.requestStats.bind(store)
    store.requestStats = async (query) => {
      queries.push(query)
      return originalRequestStats(query)
    }
    const before = Date.now()

    const result = await createController(store).stats(
      createContext('/periscope/api/stats?application=shop&bucket=30')
    )
    const after = Date.now()

    assert.lengthOf(queries, 1)
    assert.equal(queries[0].application, 'shop')
    assert.equal(queries[0].bucketSeconds, 30)
    assert.isUndefined(queries[0].groupBy)
    assert.equal(Date.parse(queries[0].to) - Date.parse(queries[0].from), 1_800_000)
    assert.isAtLeast(Date.parse(queries[0].to), before)
    assert.isAtMost(Date.parse(queries[0].to), after)
    assert.deepEqual(result, {
      data: {
        from: queries[0].from,
        to: queries[0].to,
        bucketSeconds: 30,
        groupBy: null,
        buckets: [],
        sampled: 0,
        truncated: false,
      },
    })
  })

  test('uses one window-sized bucket for group_by without an explicit bucket', async ({
    assert,
  }) => {
    const store = new MemoryStore()
    const queries: RequestStatsQuery[] = []
    const originalRequestStats = store.requestStats.bind(store)
    store.requestStats = async (query) => {
      queries.push(query)
      return originalRequestStats(query)
    }
    const from = '2026-05-01T12:00:00.000Z'
    const to = '2026-05-01T12:00:10.500Z'

    const result = await createController(store).stats(
      createContext(
        `/periscope/api/stats?group_by=route&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      )
    )

    assert.deepEqual(queries, [
      { application: undefined, from, to, bucketSeconds: 11, groupBy: 'route' },
    ])
    assert.deepEqual(result, {
      data: {
        from,
        to,
        bucketSeconds: 11,
        groupBy: 'route',
        buckets: [],
        sampled: 0,
        truncated: false,
      },
    })
  })

  test('rejects invalid bucketed analytics queries before reading the store', async ({
    assert,
  }) => {
    const rejected = [
      '/periscope/api/stats?bucket=0',
      '/periscope/api/stats?bucket=1.5',
      '/periscope/api/stats?bucket=604801',
      '/periscope/api/stats?group_by=method',
      '/periscope/api/stats?bucket=10&from=not-a-date',
      '/periscope/api/stats?bucket=10&from=2026-05-02T00%3A00%3A00Z&to=2026-05-01T00%3A00%3A00Z',
      '/periscope/api/stats?bucket=1&from=2026-05-01T00%3A00%3A00Z&to=2026-05-01T00%3A08%3A21Z',
    ]

    for (const url of rejected) {
      const store = new MemoryStore()
      let calls = 0
      store.requestStats = async () => {
        calls += 1
        return { buckets: [], sampled: 0, truncated: false }
      }
      const context = createContext(url)

      await createController(store).stats(context)

      assert.equal(context.response.getStatus(), 400, url)
      assert.equal(calls, 0, url)
    }
  })

  test('registers stats before the API catch-all', ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const store = new MemoryStore()
    const recorder = new Recorder({ config, store, enabled: true })
    const router = new RouterFactory().create()

    registerDashboardRoutes({
      router,
      recorder,
      config,
      environment: { nodeEnv: 'development', periscopeEnabled: () => undefined },
    })
    router.commit()

    assert.equal(
      router.match('/periscope/api/stats', 'GET', true)?.route.pattern,
      '/periscope/api/stats'
    )
  })
})
