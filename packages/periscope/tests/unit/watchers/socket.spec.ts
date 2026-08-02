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
  SocketWatcherAdapter,
  SocketWatcherObserver,
  SocketWatcherRegistrationOptions,
} from '../../../src/types.ts'
import { SocketWatcher } from '../../../src/watchers/socket/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

class TestSocketAdapter implements SocketWatcherAdapter {
  readonly name = 'test'
  observer: SocketWatcherObserver | null = null
  options: SocketWatcherRegistrationOptions | undefined
  registrations = 0
  teardowns = 0

  register(observer: SocketWatcherObserver, options?: SocketWatcherRegistrationOptions) {
    this.registrations++
    this.observer = observer
    this.options = options
    return () => {
      this.teardowns++
    }
  }
}

async function makeWatcher(
  options: { enabled?: boolean; capturePayload?: boolean; adapters?: SocketWatcherAdapter[] } = {}
) {
  const { app, emitter } = await createApp()
  const adapter = new TestSocketAdapter()
  const config = defineConfig({
    storage: { driver: 'memory' },
    watchers: {
      socket: {
        enabled: options.enabled ?? true,
        adapters: options.adapters ?? [adapter],
        capturePayload: options.capturePayload ?? false,
      },
    },
  })
  const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
  const watcher = new SocketWatcher({ app, emitter, config, recorder, dev: true })
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

test.group('SocketWatcher', () => {
  test('records connection, message, and disconnection lifecycle entries', async ({ assert }) => {
    const { adapter, watcher } = await makeWatcher({ capturePayload: true })
    const payload = { token: 'secret', sequence: 1n }
    const entries = capture(() => {
      adapter.observer!.connected({
        adapter: 'socket.io',
        socketId: 'socket-1',
        transport: 'websocket',
        channel: 'orders',
        remoteAddress: '127.0.0.1',
        userId: 42,
      })
      adapter.observer!.message({
        adapter: 'socket.io',
        socketId: 'socket-1',
        channel: 'orders',
        direction: 'inbound',
        event: 'order.updated',
        sizeBytes: 128,
        payload,
      })
      adapter.observer!.disconnected({
        adapter: 'socket.io',
        socketId: 'socket-1',
        transport: 'websocket',
        reason: 'client closed',
        durationMs: 900,
      })
    })

    assert.lengthOf(entries, 3)
    assert.equal(entries[0].type, EntryType.SOCKET)
    assert.deepEqual(entries[0].content, {
      adapter: 'socket.io',
      socketId: 'socket-1',
      event: 'connected',
      transport: 'websocket',
      channel: 'orders',
      remoteAddress: '127.0.0.1',
      userId: 42,
    })
    assert.deepEqual(entries[0].tags, ['socket:socket-1', 'connected', 'channel:orders'])
    assert.deepEqual(entries[1].content, {
      adapter: 'socket.io',
      socketId: 'socket-1',
      event: 'message',
      channel: 'orders',
      direction: 'inbound',
      messageEvent: 'order.updated',
      sizeBytes: 128,
      payload: { token: '[REDACTED]', sequence: '1n' },
    })
    assert.deepEqual(entries[1].tags, ['socket:socket-1', 'message', 'channel:orders', 'inbound'])
    assert.deepEqual(entries[2].content, {
      adapter: 'socket.io',
      socketId: 'socket-1',
      event: 'disconnected',
      transport: 'websocket',
      durationMs: 900,
      reason: 'client closed',
    })
    assert.deepEqual(entries[2].tags, ['socket:socket-1', 'disconnected'])
    assert.deepEqual(watcher.stats, { recorded: 3 })
    assert.deepEqual(payload, { token: 'secret', sequence: 1n })
  })

  test('strips message payloads when capturePayload is disabled', async ({ assert }) => {
    const { adapter } = await makeWatcher()
    const [entry] = capture(() =>
      adapter.observer!.message({
        adapter: 'ws',
        socketId: 'socket-2',
        direction: 'outbound',
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
      adapter.observer!.connected({ adapter: 'ws', socketId: 'socket-late' })
    )

    assert.equal(adapter.teardowns, 1)
    assert.isEmpty(entries)
  })

  test('continues registering adapters after one throws', async ({ assert }) => {
    const broken: SocketWatcherAdapter = {
      name: 'broken',
      register() {
        throw new Error('broken adapter')
      },
    }
    const healthy = new TestSocketAdapter()
    await makeWatcher({ adapters: [broken, healthy] })

    assert.equal(healthy.registrations, 1)
  })

  test('does not register adapters when disabled', async ({ assert }) => {
    const { adapter } = await makeWatcher({ enabled: false })
    assert.equal(adapter.registrations, 0)
  })
})
