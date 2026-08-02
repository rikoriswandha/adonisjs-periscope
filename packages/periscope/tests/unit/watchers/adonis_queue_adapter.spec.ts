/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import { tracingChannels } from '@adonisjs/queue'

import { AdonisQueueAdapter } from '../../../src/watchers/job_schedule/adonis_queue_adapter.ts'
import type { QueueJobEvent, QueueJobResult, QueueWatcherObserver } from '../../../src/types.ts'

test.group('AdonisQueueAdapter', () => {
  test('observes execution and delayed dispatch tracing channels', async ({ assert }) => {
    const started: QueueJobEvent[] = []
    const completed: QueueJobResult[] = []
    const failed: QueueJobResult[] = []
    const scheduled: QueueJobEvent[] = []
    const dispatching: QueueJobEvent[] = []
    const observer: QueueWatcherObserver = {
      started: (event) => started.push(event),
      completed: (event) => completed.push(event),
      failed: (event) => failed.push(event),
      scheduled: (event) => scheduled.push(event),
      dispatching: (event) => {
        dispatching.push(event)
        return { correlationId: 'adonis-dispatch-correlation' }
      },
    }
    const adapter = new AdonisQueueAdapter()
    const cleanup = await adapter.register(observer, { capturePayload: true })
    if (typeof cleanup !== 'function') {
      assert.fail('@adonisjs/queue tracing channels were not registered')
      return
    }
    getActiveTest()?.cleanup(() => cleanup())

    const execution = {
      job: {
        id: 'job-1',
        name: 'SendReceipt',
        payload: { orderId: 42 },
        attempts: 1,
      },
      queue: 'mail',
      status: undefined as string | undefined,
      duration: undefined as number | undefined,
    }
    await tracingChannels.executeChannel.tracePromise(async () => {
      execution.status = 'completed'
      execution.duration = 12.5
    }, execution as never)

    const dispatchedAt = Date.now()
    const dispatch = {
      jobs: [
        {
          id: 'job-2',
          name: 'SendDigest',
          payload: { accountId: 7 },
          attempts: 0,
          traceContext: undefined as Record<string, string> | undefined,
        },
      ],
      queue: 'mail',
      delay: 250,
    }
    await tracingChannels.dispatchChannel.tracePromise(async () => undefined, dispatch as never)

    assert.deepEqual(dispatching, [
      {
        adapter: 'adonisjs-queue',
        queue: 'mail',
        jobId: 'job-2',
        name: 'SendDigest',
        attempts: 1,
        payload: { accountId: 7 },
      },
    ])
    assert.deepEqual(dispatch.jobs[0].traceContext, {
      'periscope.queue_correlation_id': 'adonis-dispatch-correlation',
    })
    assert.deepEqual(started, [
      {
        adapter: 'adonisjs-queue',
        queue: 'mail',
        jobId: 'job-1',
        name: 'SendReceipt',
        attempts: 2,
        payload: { orderId: 42 },
      },
    ])
    assert.deepEqual(completed, [
      {
        adapter: 'adonisjs-queue',
        queue: 'mail',
        jobId: 'job-1',
        name: 'SendReceipt',
        attempts: 2,
        payload: { orderId: 42 },
        durationMs: 12.5,
      },
    ])
    assert.isEmpty(failed)
    assert.lengthOf(scheduled, 1)
    assert.deepInclude(scheduled[0], {
      adapter: 'adonisjs-queue',
      queue: 'mail',
      jobId: 'job-2',
      name: 'SendDigest',
      attempts: 1,
      payload: { accountId: 7 },
    })
    assert.isAtLeast(scheduled[0].scheduledAt!.getTime(), dispatchedAt + 250)
    assert.isAtMost(scheduled[0].scheduledAt!.getTime(), Date.now() + 250)
  })

  test('gates payloads and results and reports failures and retries', async ({ assert }) => {
    const started: QueueJobEvent[] = []
    const completed: QueueJobResult[] = []
    const failed: QueueJobResult[] = []
    const scheduled: QueueJobEvent[] = []
    const observer: QueueWatcherObserver = {
      started: (event) => started.push(event),
      completed: (event) => completed.push(event),
      failed: (event) => failed.push(event),
      scheduled: (event) => scheduled.push(event),
    }
    const adapter = new AdonisQueueAdapter()
    const cleanup = await adapter.register(observer, { capturePayload: false })
    if (typeof cleanup !== 'function') {
      assert.fail('@adonisjs/queue tracing channels were not registered')
      return
    }
    getActiveTest()?.cleanup(() => cleanup())

    const failure = new Error('delivery failed')
    const execution = {
      job: {
        id: 'job-3',
        name: 'DeliverWebhook',
        payload: { token: 'secret' },
        attempts: 0,
      },
      queue: 'webhooks',
      status: undefined as string | undefined,
      duration: undefined as number | undefined,
      error: undefined as Error | undefined,
      result: undefined as unknown,
    }
    await tracingChannels.executeChannel.tracePromise(async () => {
      execution.status = 'failed'
      execution.duration = 8
      execution.error = failure
      execution.result = { shouldNot: 'leak' }
    }, execution as never)

    const retryAt = new Date(Date.now() + 1_000)
    const retry = {
      job: {
        id: 'job-4',
        name: 'DeliverWebhook',
        payload: { token: 'secret' },
        attempts: 1,
      },
      queue: 'webhooks',
      status: undefined as string | undefined,
      nextRetryAt: undefined as Date | undefined,
    }
    await tracingChannels.executeChannel.tracePromise(async () => {
      retry.status = 'retrying'
      retry.nextRetryAt = retryAt
    }, retry as never)

    assert.notProperty(started[0], 'payload')
    assert.notProperty(failed[0], 'payload')
    assert.notProperty(failed[0], 'result')
    assert.equal(failed[0].error, failure)
    assert.equal(failed[0].durationMs, 8)
    assert.isEmpty(completed)
    assert.equal(scheduled[0].scheduledAt, retryAt)
    assert.notProperty(scheduled[0], 'payload')
  })
})
