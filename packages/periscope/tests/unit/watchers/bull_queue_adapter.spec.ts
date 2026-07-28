/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import { QueueEvents } from 'bullmq'
import type { RedisClient } from 'bullmq'

import { BullQueueAdapter } from '../../../src/watchers/job_schedule/bull_queue_adapter.ts'
import type { QueueWatcherObserver } from '../../../src/types.ts'

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
}) {
  const originalWaitUntilReady = QueueEvents.prototype.waitUntilReady
  const originalClose = QueueEvents.prototype.close
  let calls = 0

  QueueEvents.prototype.waitUntilReady = function () {
    calls += 1
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
})
