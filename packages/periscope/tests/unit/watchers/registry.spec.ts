/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { performance } from 'node:perf_hooks'
import '@adonisjs/lucid/orm'

import { getActiveTest, test } from '@japa/runner'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import type { LoggerService } from '@adonisjs/core/types'

import { defineConfig } from '../../../src/define_config.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType, WATCHER_NAMES } from '../../../src/types.ts'
import type { PeriscopeConfig, Watcher, WatcherName } from '../../../src/types.ts'
import { getActiveWatcher } from '../../../src/watchers/active.ts'
import {
  WATCHER_FACTORIES,
  WatcherRegistry,
  type WatcherFactory,
} from '../../../src/watchers/registry.ts'
import { createApp } from '../../helpers/app_factory.ts'

/**
 * The framework emitter deliberately narrows event names to the host application's augmented
 * event list. Registry tests need arbitrary names only to observe ownership and teardown, so this
 * is the exact runtime slice under test rather than a pretend application event declaration.
 */
type ListenerProbe = {
  on(event: string, listener: (data: unknown) => void): () => void
  listenerCount(event: string): number
}

type TestContext = ConstructorParameters<typeof WatcherRegistry>[0]

const WATCHER_EVENTS: Record<WatcherName, string> = {
  request: 'http:request_completed',
  query: 'db:query',
  exception: 'test:exception',
  log: 'test:log',
  event: 'test:event',
  command: 'test:command',
  mail: 'test:mail',
  cache: 'test:cache',
  model: 'test:model',
  gate: 'test:gate',
  dump: 'test:dump',
  http_client: 'test:http_client',
}

async function makeContext(options: { config?: PeriscopeConfig; enabled?: boolean } = {}) {
  const { app, emitter } = await createApp()
  const config = defineConfig({ storage: { driver: 'memory' }, ...options.config })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store, enabled: options.enabled })

  return {
    context: { app, emitter, recorder, config, dev: true } satisfies TestContext,
    emitter: emitter as unknown as ListenerProbe,
    recorder,
    store,
  }
}

function fakeFactories(create: (name: WatcherName, context: TestContext) => Watcher) {
  const factories = {} as Record<WatcherName, WatcherFactory>

  for (const name of WATCHER_NAMES) {
    factories[name] = (context) => create(name, context)
  }

  return factories
}

type StructuralListener = (...values: unknown[]) => unknown

/**
 * The registration budget must not include booting an AdonisJS application. This is the exact
 * host surface used by the shipped watchers when optional logger and Ace providers are absent,
 * plus a deterministic in-memory emitter for their subscriptions.
 */
function makeStructuralContext(enabled = true): TestContext {
  const listeners = new Map<string, Set<StructuralListener>>()
  const anyListeners = new Set<StructuralListener>()
  const emitter = {
    on(event: string, listener: StructuralListener) {
      const eventListeners = listeners.get(event) ?? new Set<StructuralListener>()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)

      return () => {
        eventListeners.delete(listener)
      }
    },
    onAny(listener: StructuralListener) {
      anyListeners.add(listener)
      return () => {
        anyListeners.delete(listener)
      }
    },
  }
  const app = {
    getEnvironment() {
      return 'test'
    },
    container: {
      hasBinding() {
        return false
      },
    },
    config: {
      get() {
        return undefined
      },
    },
  }
  const config = defineConfig({
    storage: { driver: 'memory' },
    watchers: { exception: { captureProcessErrors: false } },
  })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store, enabled })

  return { app, emitter, recorder, config, dev: true } as unknown as TestContext
}

function observeShippedFactories(
  constructed: WatcherName[],
  registered: WatcherName[],
  cleaned: WatcherName[]
): Record<WatcherName, WatcherFactory> {
  return fakeFactories((name, context) => {
    constructed.push(name)
    const watcher = WATCHER_FACTORIES[name](context)

    return {
      name: watcher.name,
      register() {
        registered.push(name)
        return watcher.register()
      },
      cleanup() {
        cleaned.push(name)
        return watcher.cleanup?.()
      },
    }
  })
}

function track(registry: WatcherRegistry): WatcherRegistry {
  getActiveTest()?.cleanup(() => registry.cleanup())
  return registry
}

test.group('WatcherRegistry', () => {
  test('register enabled watchers in WATCHER_NAMES order and skip disabled watchers', async ({
    assert,
  }) => {
    const { context } = await makeContext({
      config: {
        watchers: {
          query: { enabled: false },
          log: { enabled: false },
        },
      },
    })
    const factories = fakeFactories((name) => ({ name, register() {} }))
    const registry = track(new WatcherRegistry(context, factories))

    await registry.register()

    assert.deepEqual(
      registry.watchers.map((watcher) => watcher.name),
      WATCHER_NAMES.filter((name) => name !== 'query' && name !== 'log')
    )
  })

  test('retain an early model watcher and reuse it during full registration', async ({
    assert,
  }) => {
    const { context } = await makeContext()
    const constructed: WatcherName[] = []
    const registered: WatcherName[] = []
    const cleaned: WatcherName[] = []
    const factories = fakeFactories((name) => {
      constructed.push(name)

      return {
        name,
        register() {
          registered.push(name)
        },
        cleanup() {
          cleaned.push(name)
        },
      }
    })
    const registry = track(new WatcherRegistry(context, factories))

    await registry.register(['model'])
    const earlyModelWatcher = registry.watchers[0]
    assert.deepEqual(constructed, ['model'])
    assert.deepEqual(registered, ['model'])
    assert.deepEqual(
      registry.watchers.map((watcher) => watcher.name),
      ['model']
    )

    await registry.register(['model'])
    await registry.register()
    await registry.register()

    const expectedOrder = ['model', ...WATCHER_NAMES.filter((name) => name !== 'model')]
    assert.strictEqual(registry.watchers[0], earlyModelWatcher)
    assert.deepEqual(
      registry.watchers.map((watcher) => watcher.name),
      expectedOrder
    )
    assert.deepEqual(constructed, expectedOrder)
    assert.deepEqual(registered, expectedOrder)

    await registry.cleanup()

    assert.deepEqual(cleaned, [...expectedOrder].reverse())
  })

  test('register nothing when the recorder is disabled', async ({ assert }) => {
    const { context, emitter } = await makeContext({ enabled: false })
    let constructed = 0
    const factories = fakeFactories((name) => {
      constructed++
      return {
        name,
        register() {
          emitter.on(WATCHER_EVENTS[name], () => {})
        },
      }
    })
    const registry = track(new WatcherRegistry(context, factories))

    await registry.register()

    assert.isEmpty(registry.watchers)
    assert.equal(constructed, 0)
    assert.equal(emitter.listenerCount('db:query'), 0)
    assert.equal(emitter.listenerCount('http:request_completed'), 0)
    assert.equal(emitter.listenerCount('application:event'), 0)
  })

  test('register the shipped watcher set within the Phase 6 startup budget', async ({ assert }) => {
    /**
     * ModelWatcher's one-time optional Lucid import is prepared at module evaluation above.
     */
    const constructed: WatcherName[] = []
    const registered: WatcherName[] = []
    const cleaned: WatcherName[] = []
    const registry = track(
      new WatcherRegistry(
        makeStructuralContext(),
        observeShippedFactories(constructed, registered, cleaned)
      )
    )

    const startedAt = performance.now()
    await registry.register()
    const elapsedMs = performance.now() - startedAt

    assert.lengthOf(WATCHER_NAMES, 12)
    assert.deepEqual(constructed, WATCHER_NAMES)
    assert.deepEqual(registered, WATCHER_NAMES)
    assert.deepEqual(
      registry.watchers.map((watcher) => watcher.name),
      WATCHER_NAMES
    )
    assert.isBelow(
      elapsedMs,
      50,
      `expected all watcher registrations below 50ms, completed in ${elapsedMs.toFixed(3)}ms`
    )

    await registry.cleanup()
    await registry.cleanup()

    assert.deepEqual(cleaned, [...WATCHER_NAMES].reverse())
    assert.isEmpty(registry.watchers)

    const disabledConstructed: WatcherName[] = []
    const disabledRegistered: WatcherName[] = []
    const disabledCleaned: WatcherName[] = []
    const disabledRegistry = track(
      new WatcherRegistry(
        makeStructuralContext(false),
        observeShippedFactories(disabledConstructed, disabledRegistered, disabledCleaned)
      )
    )

    await disabledRegistry.register()
    await disabledRegistry.cleanup()
    await disabledRegistry.cleanup()

    assert.isEmpty(disabledConstructed)
    assert.isEmpty(disabledRegistered)
    assert.isEmpty(disabledCleaned)
    assert.isEmpty(disabledRegistry.watchers)
  })

  test('skip a factory that throws and continue registering later watchers', async ({ assert }) => {
    const { context } = await makeContext()
    const factories = fakeFactories((name) => {
      if (name === 'query') {
        throw new Error('query construction failed')
      }

      return { name, register() {} }
    })
    const registry = track(new WatcherRegistry(context, factories))

    await registry.register()

    assert.deepEqual(
      registry.watchers.map((watcher) => watcher.name),
      WATCHER_NAMES.filter((name) => name !== 'query')
    )
  })

  test('retain a watcher whose register rejects so its partial subscriptions are cleaned', async ({
    assert,
  }) => {
    const { context, emitter } = await makeContext({
      config: {
        watchers: {
          request: { enabled: false },
          exception: { enabled: false },
          log: { enabled: false },
          event: { enabled: false },
          command: { enabled: false },
          mail: { enabled: false },
          cache: { enabled: false },
          model: { enabled: false },
          gate: { enabled: false },
          dump: { enabled: false },
          http_client: { enabled: false },
        },
      },
    })
    let unsubscribe: (() => void) | undefined
    const factories = fakeFactories((name) => ({
      name,
      async register() {
        unsubscribe = emitter.on('db:query', () => {})
        throw new Error('registration failed after subscribing')
      },
      cleanup() {
        unsubscribe?.()
        unsubscribe = undefined
      },
    }))
    const registry = track(new WatcherRegistry(context, factories))

    await registry.register()

    assert.deepEqual(
      registry.watchers.map((watcher) => watcher.name),
      ['query']
    )
    assert.equal(emitter.listenerCount('db:query'), 1)

    await registry.cleanup()

    assert.isEmpty(registry.watchers)
    assert.equal(emitter.listenerCount('db:query'), 0)
  })

  test('clean up in reverse order, continue past failures, and remain idempotent', async ({
    assert,
  }) => {
    const { context, emitter } = await makeContext()
    const cleanupOrder: string[] = []
    const factories = fakeFactories((name) => {
      let unsubscribe: (() => void) | undefined

      return {
        name,
        register() {
          unsubscribe = emitter.on(WATCHER_EVENTS[name], () => {})
        },
        cleanup() {
          cleanupOrder.push(name)
          unsubscribe?.()
          unsubscribe = undefined

          if (name === 'exception') {
            throw new Error('exception cleanup failed')
          }
        },
      }
    })
    const registry = track(new WatcherRegistry(context, factories))

    await registry.register()
    await registry.cleanup()
    await registry.cleanup()

    assert.deepEqual(cleanupOrder, [...WATCHER_NAMES].reverse())
    assert.isEmpty(registry.watchers)

    for (const event of Object.values(WATCHER_EVENTS)) {
      assert.equal(emitter.listenerCount(event), 0)
    }
  })

  test('construct and subscribe every shipped watcher through the real factory map', async ({
    assert,
  }) => {
    const { context, emitter, recorder, store } = await makeContext({
      config: { watchers: { exception: { captureProcessErrors: false } } },
    })
    const output: string[] = []
    const logger = new LoggerFactory().merge({ enabled: true }).pushLogsTo(output).create()
    context.app.container.singleton('logger', () => logger as unknown as LoggerService)
    const registry = track(new WatcherRegistry(context, WATCHER_FACTORIES))

    await registry.register()

    assert.deepEqual(
      registry.watchers.map((watcher) => watcher.name),
      WATCHER_NAMES
    )
    assert.isNotNull(getActiveWatcher('request'))
    assert.isNotNull(getActiveWatcher('exception'))
    assert.isAbove(emitter.listenerCount('http:request_completed'), 0)
    assert.isAbove(emitter.listenerCount('db:query'), 0)
    assert.isAbove(emitter.listenerCount('application:event'), 0)

    logger.warn('real log watcher subscription')
    await recorder.flush()

    const page = await store.list({ type: EntryType.LOG })
    assert.lengthOf(page.data, 1)

    await registry.cleanup()

    assert.isNull(getActiveWatcher('request'))
    assert.isNull(getActiveWatcher('exception'))
    assert.equal(emitter.listenerCount('http:request_completed'), 0)
    assert.equal(emitter.listenerCount('db:query'), 0)
    assert.equal(emitter.listenerCount('application:event'), 0)
  })
})
