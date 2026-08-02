/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import type {
  NotificationWatcherAdapter,
  NotificationWatcherObserver,
  NotificationWatcherRegistrationOptions,
} from '../../../src/types.ts'
import { NotificationWatcher } from '../../../src/watchers/notification/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

class TestNotificationAdapter implements NotificationWatcherAdapter {
  readonly name = 'test'
  observer: NotificationWatcherObserver | null = null
  options: NotificationWatcherRegistrationOptions | undefined
  registrations = 0
  teardowns = 0

  register(
    observer: NotificationWatcherObserver,
    options?: NotificationWatcherRegistrationOptions
  ) {
    this.registrations++
    this.observer = observer
    this.options = options
    return () => {
      this.teardowns++
    }
  }
}

async function makeWatcher(
  options: {
    enabled?: boolean
    capturePayload?: boolean
    adapters?: NotificationWatcherAdapter[]
  } = {}
) {
  const { app, emitter } = await createApp()
  const adapter = new TestNotificationAdapter()
  const config = defineConfig({
    storage: { driver: 'memory' },
    watchers: {
      notification: {
        enabled: options.enabled ?? true,
        adapters: options.adapters ?? [adapter],
        capturePayload: options.capturePayload ?? false,
      },
    },
  })
  const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
  const watcher = new NotificationWatcher({ app, emitter, config, recorder, dev: true })
  await watcher.register()
  getActiveTest()?.cleanup(async () => {
    await watcher.cleanup()
    await recorder.shutdown()
  })
  return { adapter, watcher }
}

function capture(run: () => void) {
  const batch = BatchScope.createContext('request')
  BatchScope.runWith(batch, run)
  return batch.buffer
}

test.group('NotificationWatcher', () => {
  test('records sent and failed deliveries with content, serialized data, and tags', async ({
    assert,
  }) => {
    const { adapter, watcher } = await makeWatcher({ capturePayload: true })
    const payload = { password: 'secret', item: 1n }
    const entries = capture(() => {
      adapter.observer!.sent({
        adapter: 'mail',
        channel: 'email',
        notification: 'ReceiptReady',
        notifiable: 42,
        durationMs: 12,
        payload,
      })
      adapter.observer!.failed({
        adapter: 'sms',
        channel: 'sms',
        notification: 'OtpCode',
        error: new Error('provider unavailable'),
      })
    })

    assert.lengthOf(entries, 2)
    assert.equal(entries[0].type, EntryType.NOTIFICATION)
    assert.deepEqual(entries[0].content, {
      adapter: 'mail',
      channel: 'email',
      notification: 'ReceiptReady',
      status: 'sent',
      notifiable: 42,
      durationMs: 12,
      payload: { password: '[REDACTED]', item: '1n' },
    })
    assert.deepEqual(entries[0].tags, ['channel:email', 'notification:ReceiptReady', 'sent'])
    assert.equal(entries[1].content.status, 'failed')
    assert.deepInclude(entries[1].content.error as object, {
      name: 'Error',
      message: 'provider unavailable',
    })
    assert.deepEqual(entries[1].tags, ['channel:sms', 'notification:OtpCode', 'failed'])
    assert.deepEqual(watcher.stats, { sent: 1, failed: 1 })
    assert.deepEqual(payload, { password: 'secret', item: 1n })
  })

  test('strips payloads when capturePayload is disabled', async ({ assert }) => {
    const { adapter } = await makeWatcher()
    const [entry] = capture(() =>
      adapter.observer!.sent({
        adapter: 'mail',
        channel: 'email',
        notification: 'Welcome',
        payload: { private: true },
      })
    )

    assert.notProperty(entry.content, 'payload')
    assert.deepEqual(adapter.options, { capturePayload: false })
  })

  test('runs adapter teardown once and stops recording on cleanup', async ({ assert }) => {
    const { adapter, watcher } = await makeWatcher()
    await watcher.cleanup()
    await watcher.cleanup()
    const entries = capture(() =>
      adapter.observer!.sent({ adapter: 'mail', channel: 'email', notification: 'Late' })
    )

    assert.equal(adapter.teardowns, 1)
    assert.isEmpty(entries)
  })

  test('continues registering adapters after one throws', async ({ assert }) => {
    const broken: NotificationWatcherAdapter = {
      name: 'broken',
      register() {
        throw new Error('broken adapter')
      },
    }
    const healthy = new TestNotificationAdapter()
    await makeWatcher({ adapters: [broken, healthy] })

    assert.equal(healthy.registrations, 1)
  })

  test('does not register adapters when disabled', async ({ assert }) => {
    const { adapter } = await makeWatcher({ enabled: false })
    assert.equal(adapter.registrations, 0)
  })
})
