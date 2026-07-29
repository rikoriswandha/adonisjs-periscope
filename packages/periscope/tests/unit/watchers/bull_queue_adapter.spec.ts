/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import { Queue, QueueEvents } from 'bullmq'
import type { RedisClient } from 'bullmq'

import { BullQueueAdapter } from '../../../src/watchers/job_schedule/bull_queue_adapter.ts'
import type { QueueJobEvent, QueueJobResult, QueueWatcherObserver } from '../../../src/types.ts'

const observer: QueueWatcherObserver = {
  started() {},
  completed() {},
  failed() {},
  scheduled() {},
}

const connection = {
  host: '127.0.0.1',
  port: 1,
  maxRetriesPerRequest: null,
  retryStrategy: () => null,
}

function patchQueueEvents(options: {
  waitUntilReady: (call: number) => Promise<RedisClient>
  onClose?: () => void
  onReady?: (events: QueueEvents) => void
}) {
  const originalWaitUntilReady = QueueEvents.prototype.waitUntilReady
  const originalClose = QueueEvents.prototype.close
  let calls = 0

  QueueEvents.prototype.waitUntilReady = function () {
    calls += 1
    options.onReady?.(this)
    return options.waitUntilReady(calls)
  }
  QueueEvents.prototype.close = async function () {
    options.onClose?.()
    await this.disconnect().catch(() => undefined)
  }

  getActiveTest()?.cleanup(() => {
    QueueEvents.prototype.waitUntilReady = originalWaitUntilReady
    QueueEvents.prototype.close = originalClose
  })
}

function patchQueueGetJob(getJob: (jobId: string) => Promise<unknown>): void {
  const originalGetJob = Queue.prototype.getJob
  Reflect.set(Queue.prototype, 'getJob', function (jobId: string) {
    return getJob(jobId)
  })

  getActiveTest()?.cleanup(() => {
    Queue.prototype.getJob = originalGetJob
  })
}

test.group('BullQueueAdapter', () => {
  test('close every QueueEvents instance when registration partially fails', async ({ assert }) => {
    let closed = 0
    patchQueueEvents({
      waitUntilReady: (call) =>
        call === 1
          ? Promise.resolve({} as RedisClient)
          : Promise.reject(new Error('readiness failed')),
      onClose: () => {
        closed += 1
      },
    })
    const adapter = new BullQueueAdapter({
      queues: [
        { name: 'first', connection },
        { name: 'second', connection },
      ],
    })

    await assert.rejects(() => adapter.register(observer), 'readiness failed')
    assert.equal(closed, 2)
  })

  test('time out readiness and close the pending QueueEvents instance', async ({ assert }) => {
    let closed = 0
    patchQueueEvents({
      waitUntilReady: () => Promise.withResolvers<RedisClient>().promise,
      onClose: () => {
        closed += 1
      },
    })
    const adapter = new BullQueueAdapter({
      queues: [{ name: 'pending', connection }],
      readyTimeoutMs: 10,
    })

    await assert.rejects(() => adapter.register(observer), /Timed out waiting 10ms/)
    assert.equal(closed, 1)
  })

  test('close registered QueueEvents instances through the returned cleanup', async ({
    assert,
  }) => {
    let closed = 0
    patchQueueEvents({
      waitUntilReady: () => Promise.resolve({} as RedisClient),
      onClose: () => {
        closed += 1
      },
    })
    const adapter = new BullQueueAdapter({
      queues: [{ name: 'ready', connection }],
    })

    const cleanup = await adapter.register(observer)
    await cleanup()
    await cleanup()

    assert.equal(closed, 1)
  })

  test('hydrates lifecycle events with bounded job metadata lookups', async ({ assert }) => {
    let events: QueueEvents | undefined
    patchQueueEvents({
      waitUntilReady: () => Promise.resolve({} as RedisClient),
      onReady: (queueEvents) => {
        events = queueEvents
      },
    })

    let lookup = 0
    patchQueueGetJob(async () => {
      lookup += 1
      return {
        name: 'SendReceipt',
        attemptsMade: lookup === 1 ? 0 : 2,
        data: { orderId: 42 },
      }
    })

    const started: QueueJobEvent[] = []
    const completed = Promise.withResolvers<QueueJobResult>()
    const adapter = new BullQueueAdapter({
      queues: [{ name: 'mail', connection }],
    })
    const cleanup = await adapter.register(
      {
        started: (event) => started.push(event),
        completed: (event) => completed.resolve(event),
        failed() {},
        scheduled() {},
      },
      { capturePayload: true }
    )
    getActiveTest()?.cleanup(() => cleanup())

    events!.emit('active', { jobId: 'job-1', prev: 'waiting' }, 'active')
    events!.emit(
      'completed',
      {
        jobId: 'job-1',
        returnvalue: JSON.stringify({ delivered: true }),
        prev: 'active',
      },
      'completed'
    )

    const result = await completed.promise
    assert.deepEqual(started, [
      {
        adapter: 'bullmq',
        queue: 'mail',
        jobId: 'job-1',
        name: 'SendReceipt',
        attempts: 0,
        payload: { orderId: 42 },
      },
    ])
    assert.deepInclude(result, {
      adapter: 'bullmq',
      queue: 'mail',
      jobId: 'job-1',
      name: 'SendReceipt',
      attempts: 2,
      payload: { orderId: 42 },
      result: JSON.stringify({ delivered: true }),
    })
    assert.isAtLeast(result.durationMs!, 0)
    assert.equal(lookup, 2)
  })

  test('times out a job lookup and falls back to base metadata', async ({ assert }) => {
    let events: QueueEvents | undefined
    patchQueueEvents({
      waitUntilReady: () => Promise.resolve({} as RedisClient),
      onReady: (queueEvents) => {
        events = queueEvents
      },
    })
    patchQueueGetJob(() => Promise.withResolvers<unknown>().promise)

    const failed = Promise.withResolvers<QueueJobResult>()
    const adapter = new BullQueueAdapter({
      queues: [{ name: 'mail', connection }],
      jobLookupTimeoutMs: 10,
    })
    const cleanup = await adapter.register({
      started() {},
      completed() {},
      failed: (event) => failed.resolve(event),
      scheduled() {},
    })
    getActiveTest()?.cleanup(() => cleanup())

    events!.emit(
      'failed',
      {
        jobId: 'job-2',
        failedReason: 'delivery failed',
        prev: 'active',
      },
      'failed'
    )

    assert.deepEqual(await failed.promise, {
      adapter: 'bullmq',
      queue: 'mail',
      jobId: 'job-2',
      error: { message: 'delivery failed' },
    })
  })
})
