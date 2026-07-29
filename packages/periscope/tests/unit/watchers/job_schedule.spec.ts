/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'

import { defineConfig } from '../../../src/define_config.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import type {
  QueueWatcherAdapter,
  QueueWatcherObserver,
  QueueWatcherRegistrationOptions,
} from '../../../src/types.ts'
import { JobScheduleWatcher } from '../../../src/watchers/job_schedule/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

class TestQueueAdapter implements QueueWatcherAdapter {
  readonly name = 'test'
  observer: QueueWatcherObserver | null = null
  options: QueueWatcherRegistrationOptions | undefined
  cleaned = false

  register(observer: QueueWatcherObserver, options?: QueueWatcherRegistrationOptions) {
    this.observer = observer
    this.options = options
    return () => {
      this.cleaned = true
    }
  }
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function makeWatcher(capturePayload = false) {
  const { app, emitter } = await createApp()
  const adapter = new TestQueueAdapter()
  const config = defineConfig({
    storage: { driver: 'memory' },
    watchers: { job_schedule: { enabled: true, adapters: [adapter], capturePayload } },
  })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const watcher = new JobScheduleWatcher({ app, emitter, config, recorder, dev: true })
  await watcher.register()
  getActiveTest()?.cleanup(async () => {
    await watcher.cleanup()
    await recorder.shutdown()
  })
  return { adapter, recorder, store, watcher }
}

test.group('JobScheduleWatcher', () => {
  test('correlate start and completion into one persisted queue batch', async ({ assert }) => {
    const { adapter, store, watcher } = await makeWatcher(true)
    adapter.observer!.started({
      adapter: 'test',
      queue: 'mail',
      jobId: '42',
      name: 'SendReceipt',
      payload: { orderId: 7 },
    })
    adapter.observer!.completed({
      adapter: 'test',
      queue: 'mail',
      jobId: '42',
      attempts: 2,
      result: { delivered: true },
      durationMs: 17.5,
    })
    await settle()

    const page = await store.list({ type: EntryType.JOB })
    assert.lengthOf(page.data, 1)
    assert.deepInclude(page.data[0].content, {
      adapter: 'test',
      queue: 'mail',
      jobId: '42',
      name: 'SendReceipt',
      status: 'completed',
      attempts: 2,
      payload: { orderId: 7 },
      result: { delivered: true },
    })
    assert.deepEqual(adapter.options, { capturePayload: true })
    assert.equal(page.data[0].content.durationMs, 17.5)
    assert.deepEqual(watcher.stats, { jobs: 1, schedules: 0 })
  })

  test('uses terminal metadata when the start lookup had no details', async ({ assert }) => {
    const { adapter, store } = await makeWatcher(true)
    adapter.observer!.started({
      adapter: 'test',
      queue: 'mail',
      jobId: 'late-metadata',
    })
    adapter.observer!.completed({
      adapter: 'test',
      queue: 'mail',
      jobId: 'late-metadata',
      name: 'SendReceipt',
      payload: { orderId: 9 },
      attempts: 1,
    })
    await settle()

    const page = await store.list({ type: EntryType.JOB })
    assert.deepInclude(page.data[0].content, {
      name: 'SendReceipt',
      payload: { orderId: 9 },
      attempts: 1,
    })
  })

  test('evict the oldest active job correlation after the bounded capacity', async ({ assert }) => {
    const { adapter, store } = await makeWatcher(true)

    for (let index = 0; index <= 1_000; index += 1) {
      adapter.observer!.started({
        adapter: 'test',
        queue: 'bounded',
        jobId: String(index),
        name: `Job${index}`,
        payload: { index },
      })
    }

    adapter.observer!.completed({
      adapter: 'test',
      queue: 'bounded',
      jobId: '0',
    })
    adapter.observer!.completed({
      adapter: 'test',
      queue: 'bounded',
      jobId: '1000',
    })
    await settle()

    const page = await store.list({ type: EntryType.JOB })
    const evicted = page.data.find((entry) => entry.content.jobId === '0')
    const retained = page.data.find((entry) => entry.content.jobId === '1000')

    assert.isDefined(evicted)
    assert.notProperty(evicted!.content, 'durationMs')
    assert.notProperty(evicted!.content, 'payload')
    assert.isDefined(retained)
    assert.property(retained!.content, 'durationMs')
    assert.deepInclude(retained!.content, {
      name: 'Job1000',
      payload: { index: 1000 },
    })
  })

  test('persist scheduled work immediately and run adapter cleanup', async ({ assert }) => {
    const { adapter, store, watcher } = await makeWatcher()
    adapter.observer!.scheduled({
      adapter: 'test',
      queue: 'reports',
      jobId: 'nightly',
      scheduledAt: new Date(Date.now() + 60_000),
    })
    await settle()

    const page = await store.list({ type: EntryType.SCHEDULE })
    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].content.jobId, 'nightly')
    assert.isNumber(page.data[0].content.delayMs)
    await watcher.cleanup()
    assert.isTrue(adapter.cleaned)
  })

  test('await a scheduled-entry flush before cleanup resolves', async ({ assert }) => {
    const { adapter, recorder, store, watcher } = await makeWatcher()
    const save = store.save.bind(store)
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    store.save = async (entries) => {
      started.resolve()
      await gate.promise
      await save(entries)
    }

    adapter.observer!.scheduled({
      adapter: 'test',
      queue: 'reports',
      jobId: 'blocked',
    })
    await started.promise

    let cleaned = false
    const cleaning = watcher.cleanup().then(() => {
      cleaned = true
    })
    await Promise.resolve()

    assert.isTrue(adapter.cleaned)
    assert.isFalse(cleaned)
    gate.resolve()
    await cleaning
    await recorder.shutdown()
    assert.isTrue(cleaned)
  })
})
