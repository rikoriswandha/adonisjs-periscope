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
import { TransmitWatcher } from '../../../src/watchers/transmit/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

type BroadcastMessage = {
  channel: string
  payload?: unknown
  event?: string
}

type TransmitContainer = {
  singleton(binding: string, resolver: () => unknown): void
}

class StubTransmit {
  readonly #listeners = new Set<(message: BroadcastMessage) => void>()
  subscriptions = 0
  unsubscriptions = 0

  on(event: string, listener: (message: BroadcastMessage) => void): () => void {
    if (event !== 'broadcast') throw new Error(`unexpected Transmit event: ${event}`)

    this.subscriptions++
    this.#listeners.add(listener)
    return () => {
      if (this.#listeners.delete(listener)) this.unsubscriptions++
    }
  }

  broadcast(channel: string, payload?: unknown, event?: string): void {
    const message: BroadcastMessage = { channel, payload }
    if (event !== undefined) message.event = event
    for (const listener of this.#listeners) listener(message)
  }

  broadcastExcept(_channel: string, _payload: unknown, _senderUid: string | string[]): void {}
}

async function makeWatcher(transmit: object | undefined, capturePayload = false) {
  const { app, emitter } = await createApp()
  const config = defineConfig({
    storage: { driver: 'memory' },
    watchers: { transmit: { enabled: true, capturePayload } },
  })
  const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })

  if (transmit !== undefined) {
    ;(app.container as unknown as TransmitContainer).singleton('transmit', () => transmit)
  }

  const watcher = new TransmitWatcher({ app, emitter, recorder, config, dev: true })
  await watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())
  return watcher
}

test.group('TransmitWatcher', () => {
  test('remain disabled by default and no-op when the optional binding is absent', async ({
    assert,
  }) => {
    assert.deepEqual(defineConfig({}).watchers.transmit, {
      enabled: false,
      capturePayload: false,
    })

    const watcher = await makeWatcher(undefined)
    assert.deepEqual(watcher.stats, { recorded: 0 })
    assert.doesNotThrow(() => watcher.cleanup())
  })

  test('record lifecycle broadcasts in the active batch with bounded redacted payloads', async ({
    assert,
  }) => {
    const transmit = new StubTransmit()
    const watcher = await makeWatcher(transmit, true)
    const batch = BatchScope.createContext('request')
    const payload: Record<string, unknown> = {
      orderId: 42,
      password: 'do-not-store',
    }
    payload.self = payload

    await BatchScope.runWith(batch, () => {
      transmit.broadcast('orders/42', payload)
      transmit.broadcast('orders/42', { state: 'paid' }, 'order.updated')
      transmit.broadcastExcept('orders', { state: 'queued' }, 'sender-1')
    })

    assert.equal(transmit.subscriptions, 1)
    assert.deepEqual(
      batch.buffer.map((entry) => ({
        type: entry.type,
        batchId: entry.batchId,
        content: entry.content,
      })),
      [
        {
          type: EntryType.BROADCAST,
          batchId: batch.batchId,
          content: {
            channel: 'orders/42',
            payloadSummary: {
              orderId: 42,
              password: '[REDACTED]',
              self: '[Circular]',
            },
          },
        },
        {
          type: EntryType.BROADCAST,
          batchId: batch.batchId,
          content: {
            channel: 'orders/42',
            event: 'order.updated',
            payloadSummary: { state: 'paid' },
          },
        },
        {
          type: EntryType.BROADCAST,
          batchId: batch.batchId,
          content: {
            channel: 'orders',
            payloadSummary: { state: 'queued' },
          },
        },
      ]
    )
    assert.deepEqual(watcher.stats, { recorded: 3 })

    watcher.cleanup()
    watcher.cleanup()
    assert.equal(transmit.unsubscriptions, 1)

    const afterCleanup = BatchScope.createContext('request')
    await BatchScope.runWith(afterCleanup, () => transmit.broadcast('orders/43', { state: 'new' }))
    assert.lengthOf(afterCleanup.buffer, 0)
  })

  test('never inspect payloads while capture is disabled', async ({ assert }) => {
    const transmit = new StubTransmit()
    await makeWatcher(transmit)
    const payload = {}
    Object.defineProperty(payload, 'secret', {
      enumerable: true,
      get() {
        throw new Error('payload must remain unread')
      },
    })
    const batch = BatchScope.createContext('request')

    assert.doesNotThrow(() =>
      BatchScope.runWith(batch, () => transmit.broadcast('private', payload))
    )
    assert.deepEqual(batch.buffer[0].content, { channel: 'private' })
  })

  test('idempotently wrap and restore transmit-shaped services without lifecycle hooks', async ({
    assert,
  }) => {
    const calls: string[] = []
    const transmit = {
      broadcast(channel: string, _payload?: unknown) {
        calls.push(`broadcast:${channel}`)
      },
      broadcastExcept(channel: string, _payload: unknown, _senderUid: string | string[]) {
        calls.push(`broadcastExcept:${channel}`)
      },
    }
    const originalBroadcast = transmit.broadcast
    const originalBroadcastExcept = transmit.broadcastExcept
    const watcher = await makeWatcher(transmit, true)
    await watcher.register()
    const wrappedBroadcast = transmit.broadcast
    const wrappedBroadcastExcept = transmit.broadcastExcept
    const batch = BatchScope.createContext('request')

    await BatchScope.runWith(batch, () => {
      transmit.broadcast('news', { title: 'Launch' })
      transmit.broadcastExcept('alerts', { level: 'warning' }, 'sender-1')
    })

    assert.deepEqual(calls, ['broadcast:news', 'broadcastExcept:alerts'])
    assert.deepEqual(
      batch.buffer.map((entry) => entry.content),
      [
        { channel: 'news', payloadSummary: { title: 'Launch' } },
        { channel: 'alerts', payloadSummary: { level: 'warning' } },
      ]
    )
    assert.strictEqual(transmit.broadcast, wrappedBroadcast)
    assert.strictEqual(transmit.broadcastExcept, wrappedBroadcastExcept)

    watcher.cleanup()
    watcher.cleanup()
    assert.strictEqual(transmit.broadcast, originalBroadcast)
    assert.strictEqual(transmit.broadcastExcept, originalBroadcastExcept)
  })
})
