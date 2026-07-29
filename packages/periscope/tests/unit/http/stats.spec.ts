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
import type { EntryQuery } from '../../../src/types.ts'
import { makeStoredEntry } from '../../storage/contract.ts'

function createContext(url: string) {
  const context = new HttpContextFactory().merge({ url, method: 'GET' }).create()
  context.route = { pattern: url, params: {} } as unknown as typeof context.route
  return context
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
