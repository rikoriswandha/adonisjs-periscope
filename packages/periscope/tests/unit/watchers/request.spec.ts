/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'

import { defineConfig } from '../../../src/define_config.ts'
import { IncomingEntry } from '../../../src/entry.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import { findRequestBatch, isIgnoredRequest } from '../../../src/watchers/http_batch.ts'
import { RequestWatcherMiddleware } from '../../../src/watchers/request/middleware.ts'
import { RequestWatcher } from '../../../src/watchers/request/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

type UploadFixture = {
  fieldName: string
  clientName: string
  size: number
  type?: string
  extname?: string
  contents?: string
}

type ContextOptions = {
  method?: string
  url?: string
  query?: Record<string, unknown>
  payload?: Record<string, unknown>
  headers?: Record<string, string>
  status?: number
  headersSent?: boolean
  finished?: boolean
  responseBody?: unknown
  route?: { pattern: string; name?: string }
  files?: Record<string, UploadFixture | UploadFixture[]>
  session?: Record<string, unknown>
  authUser?: Record<string, unknown>
}

/**
 * The watcher uses only the public request and response observations represented here. The final
 * cast is intentional: constructing a real `HttpContext` would require a Node server and obscure
 * the unit under test behind unrelated resolver, logger and routing machinery.
 */
function makeHttpContext(options: ContextOptions = {}): HttpContext {
  const request: Record<string, unknown> = {
    method: () => options.method ?? 'GET',
    url: () => options.url ?? '/users/42',
    qs: () => options.query ?? {},
    all: () => options.payload ?? {},
    headers: () => options.headers ?? { accept: 'application/json' },
    ip: () => '127.0.0.1',
    hostname: () => 'localhost',
  }

  if (options.files !== undefined) {
    request.__raw_files = options.files
    request.allFiles = () => options.files
  }

  const hasResponseBody = Object.hasOwn(options, 'responseBody')
  const context: Record<string, unknown> = {
    request,
    response: {
      headersSent: options.headersSent ?? true,
      finished: options.finished ?? true,
      getStatus: () => options.status ?? 200,
      hasContent: hasResponseBody,
      getBody: () => options.responseBody,
      hasStream: false,
      hasFileToStream: false,
      fileToStream: undefined,
    },
    ...(options.route === undefined ? {} : { route: options.route }),
    ...(options.session === undefined ? {} : { session: { all: () => options.session } }),
    ...(options.authUser === undefined ? {} : { auth: { user: options.authUser } }),
  }

  return context as unknown as HttpContext
}

type WatcherOptions = {
  dashboardPath?: string
  slowMs?: number
  captureResponse?: boolean
  responseSizeLimitKb?: number
  captureSession?: boolean
}

async function makeWatcher(options: WatcherOptions = {}) {
  const { app, emitter } = await createApp()
  const config = defineConfig({
    storage: { driver: 'memory' },
    dashboard: { path: options.dashboardPath ?? '/periscope' },
    watchers: {
      request: {
        slowMs: options.slowMs,
        captureResponse: options.captureResponse,
        responseSizeLimitKb: options.responseSizeLimitKb,
        captureSession: options.captureSession,
      },
    },
  })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const watcher = new RequestWatcher({ app, emitter, recorder, config, dev: true })
  const middleware = new RequestWatcherMiddleware()

  watcher.register()
  getActiveTest()?.cleanup(async () => {
    watcher.cleanup()
    await recorder.shutdown()
  })

  return { emitter, middleware, recorder, store, watcher }
}

test.group('RequestWatcher', () => {
  test('record one completed request with its final method, URL, status and duration', async ({
    assert,
  }) => {
    const { emitter, middleware, store } = await makeWatcher()
    const ctx = makeHttpContext({ method: 'POST', url: '/orders', status: 201 })
    const downstreamValue = await middleware.handle(ctx, async () => 'controller result')

    assert.equal(downstreamValue, 'controller result')

    await emitter.emit('http:request_completed', { ctx, duration: [1, 25_000_000] })

    const page = await store.list({ type: EntryType.REQUEST })
    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].content.method, 'POST')
    assert.equal(page.data[0].content.url, '/orders')
    assert.equal(page.data[0].content.status, 201)
    assert.equal(page.data[0].content.durationMs, 1_025)
  })

  test('refuse and mute dashboard requests instead of re-homing their entries as ambient', async ({
    assert,
  }) => {
    const { emitter, middleware, recorder, store } = await makeWatcher({
      dashboardPath: '/debug',
    })
    const ctx = makeHttpContext({ url: '/debug/entries?type=request' })

    await middleware.handle(ctx, async () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY, { sql: 'select dashboard data' }))
    })

    assert.isTrue(isIgnoredRequest(ctx))
    assert.isUndefined(findRequestBatch(ctx))

    await emitter.emit('http:request_completed', { ctx, duration: [0, 2_000_000] })
    await recorder.flush()

    const page = await store.list()
    assert.lengthOf(page.data, 0)
  })

  test('treat a root-mounted dashboard as covering every request path', async ({ assert }) => {
    const { emitter, middleware, recorder, store } = await makeWatcher({ dashboardPath: '/' })
    const ctx = makeHttpContext({ url: '/ordinary/application/route' })

    await middleware.handle(ctx, async () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY, { sql: 'select application data' }))
    })
    await emitter.emit('http:request_completed', { ctx, duration: [0, 2_000_000] })
    await recorder.flush()

    assert.isTrue(isIgnoredRequest(ctx))
    assert.isUndefined(findRequestBatch(ctx))

    const page = await store.list()
    assert.lengthOf(page.data, 0)
  })

  test('redact request payload values before they reach storage', async ({ assert }) => {
    const { emitter, middleware, store } = await makeWatcher()
    const ctx = makeHttpContext({
      method: 'POST',
      url: '/login',
      payload: { email: 'person@example.test', password: 'x' },
    })

    await middleware.handle(ctx, async () => {})
    await emitter.emit('http:request_completed', { ctx, duration: [0, 1_000_000] })

    const page = await store.list({ type: EntryType.REQUEST })
    assert.deepEqual(page.data[0].content.payload, {
      email: 'person@example.test',
      password: '[REDACTED]',
    })
  })

  test('tag status, method and the inclusive slow-threshold boundary', async ({ assert }) => {
    const { emitter, middleware, store } = await makeWatcher({ slowMs: 10 })
    const ctx = makeHttpContext({ method: 'PATCH', status: 422 })

    await middleware.handle(ctx, async () => {})
    await emitter.emit('http:request_completed', { ctx, duration: [0, 10_000_000] })

    const page = await store.list({ type: EntryType.REQUEST })
    assert.includeMembers(page.data[0].tags, ['status:422', 'method:PATCH', 'slow'])
  })

  test('consume a parked batch exactly once when completion is emitted twice', async ({
    assert,
  }) => {
    const { emitter, middleware, store } = await makeWatcher()
    const ctx = makeHttpContext()

    await middleware.handle(ctx, async () => {})
    await emitter.emit('http:request_completed', { ctx, duration: [0, 3_000_000] })
    await emitter.emit('http:request_completed', { ctx, duration: [0, 4_000_000] })

    const page = await store.list({ type: EntryType.REQUEST })
    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].content.durationMs, 3)
  })

  test('reunify in-scope entries under one batch and stamp the route at completion', async ({
    assert,
  }) => {
    const { emitter, middleware, recorder, store } = await makeWatcher()
    const ctx = makeHttpContext()
    let requestBatchId: string | undefined

    await middleware.handle(ctx, async () => {
      const context = BatchScope.current()
      if (context === undefined) {
        throw new Error('Expected request middleware to install a batch context')
      }

      requestBatchId = context.batchId
      recorder.record(IncomingEntry.make(EntryType.QUERY, { sql: 'select 1' }))
      ctx.route = { pattern: '/users/:id', name: 'users.show' } as HttpContext['route']
    })

    await emitter.emit('http:request_completed', { ctx, duration: [0, 5_000_000] })

    if (requestBatchId === undefined) {
      throw new Error('Expected the middleware to expose the request batch id')
    }

    const entries = await store.batch(requestBatchId)
    assert.lengthOf(entries, 2)
    assert.deepEqual(
      entries.map((entry) => entry.batchId),
      [requestBatchId, requestBatchId]
    )
    assert.isTrue(entries.every((entry) => entry.tags.includes('route:/users/:id')))
  })

  test('flush stragglers recorded after an abort completes the request early', async ({
    assert,
  }) => {
    const { emitter, middleware, recorder, store } = await makeWatcher()
    const ctx = makeHttpContext({ headersSent: false, finished: false })
    let requestBatchId: string | undefined

    await middleware.handle(ctx, async () => {
      const context = BatchScope.current()
      if (context === undefined) {
        throw new Error('Expected request middleware to install a batch context')
      }

      requestBatchId = context.batchId
      await emitter.emit('http:request_completed', { ctx, duration: [0, 93_000_000] })
      assert.isUndefined(findRequestBatch(ctx))

      recorder.record(IncomingEntry.make(EntryType.QUERY, { sql: 'select after abort' }))
    })

    if (requestBatchId === undefined) {
      throw new Error('Expected the middleware to expose the request batch id')
    }

    const entries = await store.batch(requestBatchId)
    assert.lengthOf(entries, 2)
    assert.isTrue(
      entries.some(
        (entry) => entry.type === EntryType.QUERY && entry.content.sql === 'select after abort'
      )
    )
  })

  test('store upload metadata without retaining file contents', async ({ assert }) => {
    const { emitter, middleware, store } = await makeWatcher()
    const ctx = makeHttpContext({
      method: 'POST',
      files: {
        avatar: {
          fieldName: 'avatar',
          clientName: 'face.png',
          size: 512,
          type: 'image',
          extname: 'png',
          contents: 'must never be stored',
        },
      },
    })

    await middleware.handle(ctx, async () => {})
    await emitter.emit('http:request_completed', { ctx, duration: [0, 1_000_000] })

    const page = await store.list({ type: EntryType.REQUEST })
    assert.deepEqual(page.data[0].content.payload, {
      avatar: {
        fieldName: 'avatar',
        clientName: 'face.png',
        size: 512,
        type: 'image',
        extname: 'png',
      },
    })
  })

  test('record a bounded response, session values and only a small auth summary', async ({
    assert,
  }) => {
    const { emitter, middleware, store } = await makeWatcher({
      captureResponse: true,
      responseSizeLimitKb: 0,
      captureSession: true,
    })
    const ctx = makeHttpContext({
      responseBody: 'a response that cannot fit',
      session: { cartId: 7, password: 'session-secret' },
      authUser: {
        id: 42,
        email: 'person@example.test',
        password: 'model-secret',
        profile: { admin: true },
      },
    })

    await middleware.handle(ctx, async () => {})
    await emitter.emit('http:request_completed', { ctx, duration: [0, 1_000_000] })

    const page = await store.list({ type: EntryType.REQUEST })
    assert.equal(page.data[0].content.response, '[Truncated]')
    assert.deepEqual(page.data[0].content.session, { cartId: 7, password: '[REDACTED]' })
    assert.deepEqual(page.data[0].content.user, { id: 42, email: 'person@example.test' })
    assert.include(page.data[0].tags, 'Auth:42')
  })

  test('mark an unwritten client response as disconnected instead of status 200', async ({
    assert,
  }) => {
    const { emitter, middleware, store } = await makeWatcher()
    const ctx = makeHttpContext({ headersSent: false, finished: false, status: 200 })

    await middleware.handle(ctx, async () => {})
    await emitter.emit('http:request_completed', { ctx, duration: [0, 8_000_000] })

    const page = await store.list({ type: EntryType.REQUEST })
    assert.isNull(page.data[0].content.status)
    assert.isTrue(page.data[0].content.clientDisconnected)
    assert.notInclude(page.data[0].tags, 'status:200')
  })
  test('cleaning an older watcher leaves the newer application active', async ({ assert }) => {
    const first = await makeWatcher()
    const second = await makeWatcher()

    first.watcher.cleanup()

    const ctx = makeHttpContext({ url: '/owned-by-second-app' })
    await second.middleware.handle(ctx, async () => {})
    await second.emitter.emit('http:request_completed', { ctx, duration: [0, 1_000_000] })

    const page = await second.store.list({ type: EntryType.REQUEST })
    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].content.url, '/owned-by-second-app')
  })
})
