/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { Buffer } from 'node:buffer'
import { channel } from 'node:diagnostics_channel'

import { getActiveTest, test } from '@japa/runner'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import type { KeepAlwaysHook } from '../../../src/types.ts'
import { HttpClientWatcher } from '../../../src/watchers/http_client/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

const createChannel = channel('undici:request:create')
const headersChannel = channel('undici:request:headers')
const trailersChannel = channel('undici:request:trailers')
const errorChannel = channel('undici:request:error')

async function makeWatcher(
  selfAddress?: { host: string; port: number },
  recording: { sampleRate?: number; keepAlways?: KeepAlwaysHook } = {},
  httpClient: { slowMs?: number } = {}
) {
  const { app, emitter } = await createApp()
  const config = defineConfig({
    recording,
    storage: { driver: 'memory' },
    watchers: { http_client: httpClient },
  })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const context = { app, emitter, recorder, config, dev: true }
  const watcher = (() => {
    if (selfAddress === undefined) {
      return new HttpClientWatcher(context)
    }

    const previousHost = process.env.HOST
    const previousPort = process.env.PORT
    process.env.HOST = selfAddress.host
    process.env.PORT = String(selfAddress.port)
    try {
      return new HttpClientWatcher(context)
    } finally {
      if (previousHost === undefined) {
        delete process.env.HOST
      } else {
        process.env.HOST = previousHost
      }
      if (previousPort === undefined) {
        delete process.env.PORT
      } else {
        process.env.PORT = previousPort
      }
    }
  })()

  watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())

  return { recorder, store, watcher }
}

function publishCompletedRequest(request: object): void {
  createChannel.publish({ request })
  trailersChannel.publish({ request, trailers: [] })
}

async function letFlushSettle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test.group('HttpClientWatcher', () => {
  test('finalize a response once in its create-time batch and redact URL and headers', async ({
    assert,
  }) => {
    const { recorder, store } = await makeWatcher()
    const request = {
      origin: 'https://api.example.test',
      path: '/orders?token=secret&filter=active',
      method: 'post',
      headers:
        'authorization: Bearer secret\r\ncookie: session=secret\r\nx-request-id: request-1\r\n',
    }
    const source = BatchScope.createContext('request')
    const unrelated = BatchScope.createContext('ambient')

    BatchScope.runWith(source, () => {
      createChannel.publish({ request })
    })
    await recorder.flush(source)
    BatchScope.runWith(unrelated, () => {
      headersChannel.publish({
        request,
        response: {
          statusCode: 201,
          headers: [
            Buffer.from('content-type'),
            Buffer.from('application/json'),
            Buffer.from('set-cookie'),
            Buffer.from('session=other-secret'),
          ],
        },
      })
      trailersChannel.publish({ request, trailers: [] })
      errorChannel.publish({ request, error: new Error('late duplicate') })
    })

    /*
     * The late finalization landed in the closed batch's continuation window. A second final
     * flush drains that continuation immediately instead of waiting out the grace timer.
     */
    await recorder.flush(source)

    await letFlushSettle()
    const page = await store.list({ type: EntryType.HTTP_CLIENT })

    assert.lengthOf(page.data, 1)
    const entry = page.data[0]
    assert.equal(entry.batchId, source.batchId)
    assert.equal(entry.content.method, 'POST')
    assert.equal(
      entry.content.url,
      'https://api.example.test/orders?token=%5BREDACTED%5D&filter=%5BREDACTED%5D'
    )
    assert.equal(entry.content.status, 201)
    assert.isAtLeast(entry.content.durationMs as number, 0)
    assert.isTrue(entry.content.completed)
    assert.deepEqual(entry.content.requestHeaders, {
      'authorization': '[REDACTED]',
      'cookie': '[REDACTED]',
      'x-request-id': 'request-1',
    })
    assert.deepEqual(entry.content.responseHeaders, {
      'content-type': 'application/json',
      'set-cookie': '[REDACTED]',
    })
    assert.deepEqual(entry.tags, ['method:POST', 'status:201'])
    assert.notProperty(entry.content, 'error')
  })

  test('defer a sampled-out response until its request context makes a final decision', async ({
    assert,
  }) => {
    const { recorder, store } = await makeWatcher(undefined, {
      sampleRate: 0,
      keepAlways: (batch) => batch.hasEntryOfType(EntryType.HTTP_CLIENT),
    })
    const request = {
      origin: 'https://api.example.test',
      path: '/orders',
      method: 'GET',
    }
    const source = BatchScope.createContext('request')

    BatchScope.runWith(source, () => {
      publishCompletedRequest(request)
    })
    await letFlushSettle()

    const beforeFinal = await store.list()
    assert.lengthOf(beforeFinal.data, 0)
    assert.lengthOf(source.buffer, 1)

    await recorder.flush(source, 'final')

    const page = await store.list({ type: EntryType.HTTP_CLIENT })
    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].batchId, source.batchId)
    assert.lengthOf(source.buffer, 0)
  })

  test('finalize an error exactly once and unsubscribe idempotently', async ({ assert }) => {
    const { store, watcher } = await makeWatcher()
    watcher.register()
    const request = {
      origin: 'https://api.example.test',
      path: '/unavailable',
      method: 'GET',
      headers: ['x-request-id', 'request-2'],
    }

    createChannel.publish({ request })
    headersChannel.publish({ request, response: { statusCode: '503', headers: {} } })
    errorChannel.publish({ request, error: new Error('socket closed') })
    trailersChannel.publish({ request, trailers: [] })

    await letFlushSettle()
    let page = await store.list({ type: EntryType.HTTP_CLIENT })
    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].content.status, 503)
    assert.isFalse(page.data[0].content.completed)
    assert.deepInclude(page.data[0].content.error, {
      name: 'Error',
      message: 'socket closed',
    })

    assert.include(page.data[0].tags, 'failed')
    await watcher.cleanup()
    await watcher.cleanup()
    const afterCleanup = {
      origin: 'https://api.example.test',
      path: '/not-observed',
      method: 'GET',
    }
    createChannel.publish({ request: afterCleanup })
    trailersChannel.publish({ request: afterCleanup, trailers: [] })
    await letFlushSettle()

    page = await store.list({ type: EntryType.HTTP_CLIENT })
    assert.lengthOf(page.data, 1)
  })

  test('tag slow requests and failed responses or transport errors', async ({ assert }) => {
    const { store } = await makeWatcher(undefined, {}, { slowMs: 0 })
    const successful = {
      origin: 'https://api.example.test',
      path: '/successful',
      method: 'GET',
    }
    const serverError = {
      origin: 'https://api.example.test',
      path: '/server-error',
      method: 'GET',
    }
    const transportError = {
      origin: 'https://api.example.test',
      path: '/transport-error',
      method: 'GET',
    }

    publishCompletedRequest(successful)
    createChannel.publish({ request: serverError })
    headersChannel.publish({ request: serverError, response: { statusCode: 500 } })
    trailersChannel.publish({ request: serverError, trailers: [] })
    createChannel.publish({ request: transportError })
    errorChannel.publish({ request: transportError, error: new Error('connection reset') })

    await letFlushSettle()
    const listed = await store.list({ type: EntryType.HTTP_CLIENT })
    const entries = listed.data
    const successfulEntry = entries.find((entry) =>
      (entry.content.url as string).endsWith('/successful')
    )
    const serverErrorEntry = entries.find((entry) =>
      (entry.content.url as string).endsWith('/server-error')
    )
    const transportErrorEntry = entries.find((entry) =>
      (entry.content.url as string).endsWith('/transport-error')
    )

    assert.include(successfulEntry!.tags, 'slow')
    assert.notInclude(successfulEntry!.tags, 'failed')
    assert.includeMembers(serverErrorEntry!.tags, ['slow', 'failed'])
    assert.includeMembers(transportErrorEntry!.tags, ['slow', 'failed'])
  })

  test('skip dashboard requests for exact normalized localhost and custom HOST names', async ({
    assert,
  }) => {
    const addresses = [
      { configuredHost: ' LOCALHOST ', requestHost: 'localhost' },
      { configuredHost: 'Dashboard.Internal.Test', requestHost: 'dashboard.internal.test' },
    ]

    for (const { configuredHost, requestHost } of addresses) {
      const { store, watcher } = await makeWatcher({ host: configuredHost, port: 3333 })
      publishCompletedRequest({
        origin: `http://${requestHost}:3333`,
        path: '/periscope/api/entries?token=dashboard-secret',
        method: 'GET',
      })
      publishCompletedRequest({
        origin: `http://${requestHost}:3333`,
        path: '/health',
        method: 'GET',
      })
      await letFlushSettle()

      const page = await store.list({ type: EntryType.HTTP_CLIENT })
      assert.lengthOf(page.data, 1)
      assert.equal(page.data[0].content.url, `http://${requestHost}:3333/health`)
      watcher.cleanup()
    }
  })

  test('map wildcard binds only to loopback aliases', async ({ assert }) => {
    const { store } = await makeWatcher({ host: '0.0.0.0', port: 3333 })
    publishCompletedRequest({
      origin: 'http://localhost:3333',
      path: '/periscope/api/entries',
      method: 'GET',
    })
    publishCompletedRequest({
      origin: 'http://127.0.0.42:3333',
      path: '/periscope/api/entries',
      method: 'GET',
    })
    publishCompletedRequest({
      origin: 'http://0.0.0.0:3333',
      path: '/periscope/api/entries',
      method: 'GET',
    })
    await letFlushSettle()

    const page = await store.list({ type: EntryType.HTTP_CLIENT })
    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].content.url, 'http://0.0.0.0:3333/periscope/api/entries')
  })

  test('preserve exact host, port, and dashboard path boundaries', async ({ assert }) => {
    const { store } = await makeWatcher({ host: 'dashboard.internal.test', port: 3333 })
    publishCompletedRequest({
      origin: 'http://dashboard.internal.test:3333',
      path: '/periscope/api/entries',
      method: 'GET',
    })

    const boundaryRequests = [
      {
        origin: 'http://other.internal.test:3333',
        path: '/periscope/api/entries',
        method: 'GET',
      },
      {
        origin: 'http://dashboard.internal.test:3334',
        path: '/periscope/api/entries',
        method: 'GET',
      },
      {
        origin: 'http://dashboard.internal.test:3333',
        path: '/periscope-other/api/entries',
        method: 'GET',
      },
    ]
    for (const request of boundaryRequests) {
      publishCompletedRequest(request)
    }
    await letFlushSettle()

    const page = await store.list({ type: EntryType.HTTP_CLIENT })
    assert.lengthOf(page.data, boundaryRequests.length)
    for (const request of boundaryRequests) {
      assert.isTrue(
        page.data.some((entry) => entry.content.url === `${request.origin}${request.path}`)
      )
    }
  })

  test('await an in-flight intermediate flush during cleanup', async ({ assert }) => {
    const { store, watcher } = await makeWatcher()
    const save = store.save.bind(store)
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    store.save = async (entries) => {
      started.resolve()
      await gate.promise
      await save(entries)
    }

    publishCompletedRequest({
      origin: 'https://api.example.test',
      path: '/slow-save',
      method: 'GET',
    })
    await started.promise

    let cleaned = false
    const cleaning = watcher.cleanup().then(() => {
      cleaned = true
    })
    await Promise.resolve()
    assert.isFalse(cleaned)

    gate.resolve()
    await cleaning
    assert.isTrue(cleaned)
  })
})
