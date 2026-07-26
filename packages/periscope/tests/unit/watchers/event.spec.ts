/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import { BaseEvent } from '@adonisjs/core/events'
import type { EmitterService } from '@adonisjs/core/types'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import { EventWatcher } from '../../../src/watchers/event/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

/**
 * The application's augmented emitter type intentionally knows only registered events. These
 * tests exercise arbitrary application names, so this narrow adapter exposes the wider runtime
 * contract implemented by the factory emitter without weakening payloads to `any`.
 */
type TestEmitter = {
  emit(event: string, data: unknown): Promise<void>
}

async function makeWatcher(ignore: string[] = []) {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { event: { ignore } } })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const watcher = new EventWatcher({ app, emitter, recorder, config, dev: true })

  watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())

  return { emitter, watcher }
}

/**
 * Emit one event in an explicit request context and return that context for assertions. The named
 * variable makes the test's unchecked conversion visible: the factory emitter implements the
 * broad string-key API even though `EmitterService` exposes only augmented application names.
 */
async function captureEvent(emitter: EmitterService, event: string, data: unknown) {
  const runtimeEmitter = emitter as unknown as TestEmitter
  const context = BatchScope.createContext('request')

  await BatchScope.runWith(context, () => runtimeEmitter.emit(event, data))
  return context
}

test.group('EventWatcher', () => {
  test('record a custom string event with its serialised payload', async ({ assert }) => {
    const { emitter, watcher } = await makeWatcher()
    const context = await captureEvent(emitter, 'order:created', { orderId: 42 })

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].type, EntryType.EVENT)
    assert.deepEqual(context.buffer[0].content, {
      name: 'order:created',
      payload: { orderId: 42 },
      isClassEvent: false,
      listenerCount: 0,
    })
    assert.deepEqual(context.buffer[0].tags, ['event:order:created'])
    assert.deepEqual(watcher.stats, { recorded: 1, ignored: 0 })
  })

  test('drop framework events which have dedicated watchers', async ({ assert }) => {
    const { emitter, watcher } = await makeWatcher()
    const runtimeEmitter = emitter as unknown as TestEmitter
    const context = BatchScope.createContext('request')

    await BatchScope.runWith(context, async () => {
      await runtimeEmitter.emit('db:query', { sql: 'select 1' })
      await runtimeEmitter.emit('http:request_completed', { status: 200 })
      await runtimeEmitter.emit('session:initiated', { id: 'session-1' })
      await runtimeEmitter.emit('periscope:flushed', { entries: 1 })
    })

    assert.lengthOf(context.buffer, 0)
    assert.deepEqual(watcher.stats, { recorded: 0, ignored: 4 })
  })

  test('record a BaseEvent subclass under its class name', async ({ assert }) => {
    const { emitter, watcher } = await makeWatcher()

    class OrderPaid extends BaseEvent {
      constructor(public orderId: number) {
        super()
      }
    }

    OrderPaid.useEmitter(emitter)
    const context = BatchScope.createContext('request')
    await BatchScope.runWith(context, () => OrderPaid.dispatch(73))

    assert.lengthOf(context.buffer, 1)
    assert.deepEqual(context.buffer[0].content, {
      name: 'OrderPaid',
      payload: { __class: 'OrderPaid', orderId: 73 },
      isClassEvent: true,
      className: 'OrderPaid',
      listenerCount: 0,
    })
    assert.deepEqual(context.buffer[0].tags, ['event:OrderPaid', 'class'])
    assert.deepEqual(watcher.stats, { recorded: 1, ignored: 0 })
  })

  test('apply anchored ignore globs while escaping regex syntax', async ({ assert }) => {
    const { emitter, watcher } = await makeWatcher(['order:*', 'literal.+'])
    const runtimeEmitter = emitter as unknown as TestEmitter
    const context = BatchScope.createContext('request')

    await BatchScope.runWith(context, async () => {
      await runtimeEmitter.emit('order:created', { id: 1 })
      await runtimeEmitter.emit('literal.+', { id: 2 })
      await runtimeEmitter.emit('preorder:created', { id: 3 })
      await runtimeEmitter.emit('literalX', { id: 4 })
    })

    assert.deepEqual(
      context.buffer.map((entry) => entry.content.name),
      ['preorder:created', 'literalX']
    )
    assert.deepEqual(watcher.stats, { recorded: 2, ignored: 2 })
  })

  test('bound and serialise a cyclic application payload without throwing', async ({ assert }) => {
    const { emitter } = await makeWatcher()
    const payload: Record<string, unknown> = {}
    payload.self = payload
    payload.message = 'x'.repeat(20_000)

    const context = await captureEvent(emitter, 'payload:large', payload)
    const serialised = context.buffer[0].content.payload

    assert.lengthOf(context.buffer, 1)
    assert.doesNotThrow(() => JSON.stringify(serialised))
    assert.isBelow(Buffer.byteLength(JSON.stringify(serialised)), 9 * 1024)
    if (serialised === null || typeof serialised !== 'object') {
      throw new Error('Expected the event payload to serialise as an object')
    }

    assert.equal('self' in serialised ? serialised.self : undefined, '[Circular]')
    assert.notEqual('message' in serialised ? serialised.message : undefined, payload.message)
  })

  test('join events emitted inside BatchScope.run to that batch', async ({ assert }) => {
    const { emitter } = await makeWatcher()
    const runtimeEmitter = emitter as unknown as TestEmitter

    await BatchScope.run('request', async () => {
      const context = BatchScope.current()
      if (context === undefined) {
        throw new Error('Expected BatchScope.run to install a request context')
      }

      await runtimeEmitter.emit('batch:joined', { ok: true })

      assert.lengthOf(context.buffer, 1)
      assert.equal(context.buffer[0].batchId, context.batchId)
      assert.equal(context.buffer[0].content.name, 'batch:joined')
    })
  })

  test('unsubscribe exactly once during cleanup', async ({ assert }) => {
    const { emitter, watcher } = await makeWatcher()

    assert.doesNotThrow(() => {
      watcher.cleanup()
      watcher.cleanup()
    })

    const context = await captureEvent(emitter, 'after:cleanup', { ignored: true })
    assert.lengthOf(context.buffer, 0)
  })
})
