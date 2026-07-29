/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

import { test } from '@japa/runner'
import { HttpContextFactory, RouterFactory } from '@adonisjs/core/factories/http'
import type { HttpContext } from '@adonisjs/core/http'

import { defineConfig } from '../../../src/define_config.ts'
import { MonitoredTagsController } from '../../../src/http/controllers/monitored_tags_controller.ts'
import { StreamController } from '../../../src/http/controllers/stream_controller.ts'
import { registerDashboardRoutes } from '../../../src/http/routes.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import type { FlushedEvent, FlushedListener, ResolvedPeriscopeConfig } from '../../../src/types.ts'

function createRecorder(config: ResolvedPeriscopeConfig) {
  const store = new MemoryStore()
  const recorder = new Recorder({ config, store, enabled: true })
  return { recorder, store }
}

function createContext(
  url: string,
  method: string = 'GET',
  params: Record<string, unknown> = {}
): HttpContext {
  const context = new HttpContextFactory().merge({ url, method }).create()
  context.params = params
  context.route = { pattern: url, params } as unknown as typeof context.route
  return context
}

class FlushedSource {
  subscriptions = 0
  unsubscriptions = 0
  #listener?: FlushedListener

  subscribeFlushed(listener: FlushedListener): () => void {
    this.subscriptions += 1
    this.#listener = listener
    let active = true

    return () => {
      if (!active) return
      active = false
      this.unsubscriptions += 1
      if (this.#listener === listener) this.#listener = undefined
    }
  }

  emit(event: FlushedEvent): void {
    this.#listener?.(event)
  }
}

function closeStream(context: HttpContext): void {
  context.response.response.emit('close')
}

test.group('Dashboard live HTTP API', () => {
  test('list and idempotently toggle validated monitored tags', async ({ assert }) => {
    const store = new MemoryStore()
    const controller = new MonitoredTagsController(store)

    for (const tag of ['tenant:42', 'alpha', 'tenant:42']) {
      const context = createContext('/periscope/api/monitored-tags/:tag', 'PUT', { tag })
      await controller.set(context)
      assert.equal(context.response.getStatus(), 204)
    }

    assert.deepEqual(await controller.index(), { data: ['alpha', 'tenant:42'] })

    for (const tag of ['absent', 'tenant:42', 'tenant:42']) {
      const context = createContext('/periscope/api/monitored-tags/:tag', 'DELETE', { tag })
      await controller.delete(context)
      assert.equal(context.response.getStatus(), 204)
    }

    assert.deepEqual(await controller.index(), { data: ['alpha'] })

    for (const tag of ['', 'x'.repeat(192), undefined]) {
      const context = createContext('/periscope/api/monitored-tags/:tag', 'PUT', { tag })
      await controller.set(context)
      assert.equal(context.response.getStatus(), 400)
    }
    assert.deepEqual(await controller.index(), { data: ['alpha'] })
  })

  test('frame flushed events and keepalive comments as valid SSE', async ({ assert }) => {
    const source = new FlushedSource()
    const controller = new StreamController(source, 25)
    const context = createContext('/periscope/api/stream')
    controller.stream(context)
    const body = context.response.outgoingStream as PassThrough

    assert.equal(context.response.getHeaders()['content-type'], 'text/event-stream; charset=utf-8')
    assert.equal(context.response.getHeaders()['cache-control'], 'no-cache, no-transform')
    assert.equal(body.read().toString(), ': connected\n\n')

    const event: FlushedEvent = {
      type: EntryType.QUERY,
      uuid: 'entry-1',
      indexRow: {
        uuid: 'entry-1',
        batchId: 'batch-1',
        application: 'default',
        type: EntryType.QUERY,
        familyHash: 'select-users',
        tags: ['slow'],
        shouldDisplayOnIndex: true,
        sequence: '42',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    }
    source.emit(event)

    assert.equal(body.read().toString(), `event: flush\ndata: ${JSON.stringify(event)}\n\n`)

    await delay(60)
    assert.include(body.read().toString(), ': keepalive\n\n')
    closeStream(context)
    assert.equal(source.unsubscriptions, 1)
  })

  test('honor the configured active stream cap and release capacity on disconnect', ({
    assert,
  }) => {
    const source = new FlushedSource()
    const controller = new StreamController(source, { maxClients: 2 })
    const clients = Array.from({ length: 2 }, () => createContext('/periscope/api/stream'))

    for (const client of clients) controller.stream(client)
    assert.equal(source.subscriptions, 1)

    const rejected = createContext('/periscope/api/stream')
    controller.stream(rejected)
    assert.equal(rejected.response.getStatus(), 429)
    assert.equal(rejected.response.getHeaders()['retry-after'], '5')
    assert.isUndefined(rejected.response.outgoingStream)
    assert.equal(source.subscriptions, 1)

    closeStream(clients[0])
    const replacement = createContext('/periscope/api/stream')
    controller.stream(replacement)
    assert.instanceOf(replacement.response.outgoingStream, PassThrough)
    assert.equal(source.subscriptions, 1)
    assert.equal(source.unsubscriptions, 0)

    for (const client of clients.slice(1)) closeStream(client)
    closeStream(replacement)
    assert.equal(source.unsubscriptions, 1)
  })

  test('register the SSE endpoint as GET-only without consuming capacity for HEAD', ({
    assert,
  }) => {
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

    const streamRoute = router.match('/periscope/api/stream', 'GET', true)?.route
    const headRoute = router.match('/periscope/api/stream', 'HEAD', true)?.route

    assert.deepEqual(streamRoute?.methods, ['GET'])
    assert.equal(headRoute?.pattern, '/periscope/api/*')

    const headHandler = headRoute?.handler
    assert.isFunction(headHandler)
    if (typeof headHandler !== 'function') return

    const head = createContext('/periscope/api/stream', 'HEAD')
    headHandler(head)
    assert.equal(head.response.getStatus(), 404)
    assert.isUndefined(head.response.outgoingStream)

    const streamHandler = streamRoute?.handler
    assert.isFunction(streamHandler)
    if (typeof streamHandler !== 'function') return

    const clients = Array.from({ length: 5 }, () => createContext('/periscope/api/stream'))
    for (const client of clients) {
      streamHandler(client)
      assert.instanceOf(client.response.outgoingStream, PassThrough)
    }

    for (const client of clients) closeStream(client)
  })

  test('register live and monitored-tag routes before the API catch-all', ({ assert }) => {
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

    const streamRoute = router.match('/periscope/api/stream', 'GET', true)?.route
    const monitoredTagsRoute = router.match('/periscope/api/monitored-tags', 'GET', true)?.route

    assert.equal(streamRoute?.pattern, '/periscope/api/stream')
    assert.equal(monitoredTagsRoute?.pattern, '/periscope/api/monitored-tags')
    assert.equal(
      router.match('/periscope/api/monitored-tags/slow', 'PUT', true)?.route.pattern,
      '/periscope/api/monitored-tags/:tag'
    )
    assert.equal(
      router.match('/periscope/api/monitored-tags/slow', 'DELETE', true)?.route.pattern,
      '/periscope/api/monitored-tags/:tag'
    )
    assert.equal(streamRoute?.middleware.all().size, 2)
    assert.equal(monitoredTagsRoute?.middleware.all().size, 2)
  })
})
