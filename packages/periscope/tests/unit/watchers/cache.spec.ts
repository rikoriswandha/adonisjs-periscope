/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import type { EmitterService } from '@adonisjs/core/types'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import { CacheWatcher } from '../../../src/watchers/cache/watcher.ts'
import { EventWatcher } from '../../../src/watchers/event/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

type RuntimeEmitter = {
  emit(event: string, payload: unknown): Promise<void>
}

async function makeContext(captureValues = false) {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { cache: { captureValues } } })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })

  return { app, emitter, config, recorder }
}

async function makeWatcher(captureValues = false) {
  const context = await makeContext(captureValues)
  const watcher = new CacheWatcher({ ...context, dev: true })

  watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())

  return { ...context, watcher }
}

async function capture(
  emitter: EmitterService,
  emit: (runtimeEmitter: RuntimeEmitter) => Promise<void>
) {
  const context = BatchScope.createContext('request')
  await BatchScope.runWith(context, () => emit(emitter as unknown as RuntimeEmitter))
  return context
}

test.group('CacheWatcher', () => {
  test('record the five Bentocache events with their mapped content and semantic tags', async ({
    assert,
  }) => {
    const { emitter, watcher } = await makeWatcher()
    const context = await capture(emitter, async (runtimeEmitter) => {
      await runtimeEmitter.emit('cache:hit', {
        key: 'users:1',
        value: { name: 'virk' },
        store: 'redis',
        layer: 'l2',
        graced: true,
      })
      await runtimeEmitter.emit('cache:miss', { key: 'users:2', store: 'redis' })
      await runtimeEmitter.emit('cache:written', {
        key: 'users:3',
        value: { name: 'romain' },
        store: 'memory',
      })
      await runtimeEmitter.emit('cache:deleted', { key: 'users:4', store: 'redis' })
      await runtimeEmitter.emit('cache:cleared', { store: 'memory' })
      await runtimeEmitter.emit('cache:expire', { key: 'users:5', store: 'redis' })
    })

    assert.deepEqual(
      context.buffer.map((entry) => entry.content),
      [
        {
          operation: 'hit',
          store: 'redis',
          key: 'users:1',
          layer: 'l2',
          graced: true,
        },
        { operation: 'miss', store: 'redis', key: 'users:2' },
        { operation: 'set', store: 'memory', key: 'users:3' },
        { operation: 'delete', store: 'redis', key: 'users:4' },
        { operation: 'clear', store: 'memory' },
      ]
    )
    assert.deepEqual(
      context.buffer.map((entry) => entry.tags),
      [
        ['operation:hit', 'store:redis', 'layer:l2', 'graced'],
        ['operation:miss', 'store:redis'],
        ['operation:set', 'store:memory'],
        ['operation:delete', 'store:redis'],
        ['operation:clear', 'store:memory'],
      ]
    )
    assert.deepEqual(
      context.buffer.map((entry) => entry.type),
      Array.from({ length: 5 }, () => EntryType.CACHE)
    )
    assert.deepEqual(watcher.stats, { recorded: 5 })
  })

  test('never read values while capture is disabled and safely serialize them when enabled', async ({
    assert,
  }) => {
    const withoutValues = await makeWatcher()
    const unreadValue = { key: 'secret', store: 'memory' }
    Object.defineProperty(unreadValue, 'value', {
      get() {
        throw new Error('cache value must remain unread')
      },
    })

    const hiddenContext = await capture(withoutValues.emitter, (runtimeEmitter) =>
      runtimeEmitter.emit('cache:written', unreadValue)
    )

    assert.deepEqual(hiddenContext.buffer[0].content, {
      operation: 'set',
      store: 'memory',
      key: 'secret',
    })

    const withValues = await makeWatcher(true)
    const cyclic: Record<string, unknown> = { label: 'captured' }
    cyclic.self = cyclic
    const capturedContext = await capture(withValues.emitter, (runtimeEmitter) =>
      runtimeEmitter.emit('cache:hit', {
        key: 'serialized',
        value: cyclic,
        store: 'memory',
        layer: 'l1',
        graced: false,
      })
    )

    assert.deepEqual(capturedContext.buffer[0].content, {
      operation: 'hit',
      store: 'memory',
      key: 'serialized',
      layer: 'l1',
      graced: false,
      value: { label: 'captured', self: '[Circular]' },
    })
  })

  test('swallow recording failures instead of rejecting the host event', async ({ assert }) => {
    const { emitter, recorder, watcher } = await makeWatcher(true)
    Object.defineProperty(recorder, 'record', {
      value() {
        throw new Error('broken recorder')
      },
    })

    const context = await capture(emitter, (runtimeEmitter) =>
      runtimeEmitter.emit('cache:written', {
        key: 'host-event',
        value: 'still succeeds',
        store: 'memory',
      })
    )

    assert.lengthOf(context.buffer, 0)
    assert.deepEqual(watcher.stats, { recorded: 0 })
  })

  test('register and clean up idempotently while isolating broken unsubscribers', async ({
    assert,
  }) => {
    const context = await makeContext()
    let registrations = 0
    let cleanupCalls = 0
    const source = {
      on() {
        registrations++
        return () => {
          cleanupCalls++
          if (cleanupCalls === 1) {
            throw new Error('broken unsubscribe')
          }
        }
      },
    }
    const watcher = new CacheWatcher({
      ...context,
      emitter: source as unknown as EmitterService,
      dev: true,
    })

    watcher.register()
    watcher.register()
    assert.equal(registrations, 5)

    assert.doesNotThrow(() => watcher.cleanup())
    assert.doesNotThrow(() => watcher.cleanup())
    assert.equal(cleanupCalls, 5)

    watcher.register()
    assert.equal(registrations, 10)
    assert.doesNotThrow(() => watcher.cleanup())
    assert.equal(cleanupCalls, 10)
  })

  test('do not duplicate cache events through the generic EventWatcher', async ({ assert }) => {
    const context = await makeContext(true)
    const eventWatcher = new EventWatcher({ ...context, dev: true })
    const cacheWatcher = new CacheWatcher({ ...context, dev: true })

    eventWatcher.register()
    cacheWatcher.register()
    getActiveTest()?.cleanup(() => {
      cacheWatcher.cleanup()
      eventWatcher.cleanup()
    })

    const batch = await capture(context.emitter, (runtimeEmitter) =>
      runtimeEmitter.emit('cache:hit', {
        key: 'one-entry',
        value: 42,
        store: 'memory',
        layer: 'l1',
        graced: false,
      })
    )

    assert.lengthOf(batch.buffer, 1)
    assert.equal(batch.buffer[0].type, EntryType.CACHE)
    assert.deepEqual(eventWatcher.stats, { recorded: 0, ignored: 1 })
    assert.deepEqual(cacheWatcher.stats, { recorded: 1 })
  })
})
