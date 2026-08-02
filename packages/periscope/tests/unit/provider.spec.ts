/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { test } from '@japa/runner'
import { BaseModel } from '@adonisjs/lucid/orm'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { RouterFactory } from '@adonisjs/core/factories/http'
import type { ApplicationService, LoggerService } from '@adonisjs/core/types'

import PeriscopeProvider from '../../providers/periscope_provider.ts'
import { IncomingEntry } from '../../src/entry.ts'
import { EntryType } from '../../src/types.ts'
import { Recorder } from '../../src/recorder/recorder.ts'
import { BatchScope } from '../../src/recorder/context.ts'
import { defineConfig } from '../../src/define_config.ts'
import { safeguard, setInternalLogger } from '../../src/safeguard.ts'
import { MemoryStore } from '../../src/storage/memory_store.ts'
import { SqliteLocalStore } from '../../src/storage/sqlite_local_store.ts'
import { getActiveWatcher } from '../../src/watchers/active.ts'
import { PeriscopeConfigError, PeriscopeStorageError } from '../../src/errors.ts'
import { createApp } from '../helpers/app_factory.ts'
import type { ResolvedPeriscopeConfig } from '../../src/types.ts'

type ListenerProbe = {
  listenerCount(event?: string): number
}

function pinoDestination(pino: object): unknown {
  const symbol = Object.getOwnPropertySymbols(pino).find(
    (candidate) => candidate.description === 'pino.stream'
  )

  if (symbol === undefined) {
    throw new Error('Test logger has no pino.stream destination')
  }

  return (pino as unknown as Record<symbol, unknown>)[symbol]
}

/**
 * A driver `createStore` refuses to build in a bare unit-test application: nothing binds
 * `lucid.db`, so the `database` driver has no database service to borrow. It is the sharpest
 * available probe for "did the provider construct the configured store?" — naming it makes store
 * construction throw, so a code path that reaches `createStore` cannot pretend it did not.
 */
const UNBUILDABLE_DRIVER = 'database' as const

/**
 * One shape of `config/periscope.ts` that never went through `defineConfig()` — the mistake the
 * provider's resolved-config check exists to catch. The blocks present here are deliberate so
 * the error can be held to naming only what is actually missing.
 */
const UNRESOLVED_CONFIG = {
  enabled: true,
  enabledIn: ['development'],
  storage: { driver: 'memory', maxEntries: 10 },
  recording: { caps: {}, ambientRotationMs: 10_000, pausedFlagTtlMs: 5_000 },
  watchers: {},
  dashboard: { path: '/periscope' },
}

/**
 * The config for the tests whose subject is not the storage driver.
 *
 * `memory` is spelled out rather than left to `defineConfig({})`: the shipped default is
 * `sqlite-local`, so an empty config would have every one of these tests open a real database
 * file under the throwaway application's `tmp/` — slower, and one leaked handle away from a
 * suite that hangs instead of failing.
 */
function inertConfig(): ResolvedPeriscopeConfig {
  return defineConfig({ storage: { driver: 'memory' } })
}

/**
 * A throwaway application with `config/periscope.ts` seeded, plus an unregistered provider bound
 * to it. `register()` has already run, because every path under test starts there.
 *
 * `nodeEnv` is written to `process.env` *before* the application is created: `app.nodeEnvironment`
 * is snapshotted during `init()`, and it is the left half of the environment gate the provider
 * consults. The group hook below puts it back.
 */
async function createProvider(
  options: {
    periscope?: unknown
    nodeEnv?: string
    environment?: 'web' | 'console' | 'test' | 'repl' | 'unknown'
  } = {}
): Promise<{ app: ApplicationService; provider: PeriscopeProvider }> {
  process.env.NODE_ENV = options.nodeEnv ?? 'development'

  const { app } = await createApp({
    config: options.periscope === undefined ? {} : { periscope: options.periscope },
    environment: options.environment,
  })

  const provider = new PeriscopeProvider(app)
  provider.register()

  return { app, provider }
}

test.group('PeriscopeProvider', (group) => {
  group.each.setup(() => {
    const nodeEnv = process.env.NODE_ENV
    const periscopeEnabled = process.env.PERISCOPE_ENABLED

    /**
     * `PERISCOPE_ENABLED` overrides the config gate outright, so a developer running the suite
     * with it exported would otherwise flip the enabled/disabled tests below into each other.
     */
    delete process.env.PERISCOPE_ENABLED

    return () => {
      if (nodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = nodeEnv
      }

      if (periscopeEnabled !== undefined) {
        process.env.PERISCOPE_ENABLED = periscopeEnabled
      }

      setInternalLogger(null)
    }
  })

  test('bind the recorder as a container singleton', async ({ assert }) => {
    const { app } = await createProvider({ periscope: inertConfig() })

    const first = await app.container.make(Recorder)
    const second = await app.container.make(Recorder)

    assert.instanceOf(first, Recorder)
    assert.strictEqual(first, second)
  })

  test('boot a custom store and record from a custom watcher', async ({ assert }) => {
    const store = new MemoryStore()
    const config = defineConfig({
      storage: {
        driver: 'custom',
        factory: () => store,
      },
      watchers: {
        custom: [
          ({ recorder }) => ({
            name: 'application',
            register() {
              recorder.record(IncomingEntry.make(EntryType.EVENT, { source: 'custom' }))
            },
          }),
        ],
      },
    })
    const { app, provider } = await createProvider({ periscope: config })

    await provider.ready()
    const recorder = await app.container.make(Recorder)
    await recorder.flush()

    assert.strictEqual(recorder.store, store)
    const listed = await store.list({ type: EntryType.EVENT })
    assert.equal(listed.data[0].content.source, 'custom')

    await provider.shutdown()
  })

  test('bridge flushed entries through the configured fanout and close it on shutdown', async ({
    assert,
  }) => {
    let published = 0
    let closed = 0
    let factoryApp: ApplicationService | undefined
    let factoryConfig: ResolvedPeriscopeConfig | undefined
    const config = defineConfig({
      storage: { driver: 'memory' },
      dashboard: {
        fanout: async (context) => {
          await Promise.resolve()
          factoryApp = context.app
          factoryConfig = context.config
          return {
            publish() {
              published += 1
            },
            subscribe: () => () => {},
            close() {
              closed += 1
            },
          }
        },
      },
    })
    const { app, provider } = await createProvider({ periscope: config })

    await provider.boot()
    const recorder = await app.container.make(Recorder)
    recorder.record(IncomingEntry.make(EntryType.EVENT, { source: 'fanout' }))
    await recorder.flush()

    assert.strictEqual(factoryApp, app)
    assert.strictEqual(factoryConfig, config)
    assert.equal(published, 1)

    await provider.shutdown()
    assert.equal(closed, 1)
  })

  test('register dashboard routes from start in web processes', async ({ assert }) => {
    const { app, provider } = await createProvider({
      periscope: inertConfig(),
      environment: 'web',
    })
    const router = new RouterFactory().merge({ app }).create()
    app.container.singleton('router', () => router)

    await provider.start()
    router.commit()

    assert.equal(
      router.match('/periscope/api/status', 'GET', true)?.route.pattern,
      '/periscope/api/status'
    )
  })

  test('do not resolve or register the router outside web processes', async ({ assert }) => {
    for (const environment of ['console', 'test', 'repl', 'unknown'] as const) {
      const { app, provider } = await createProvider({
        periscope: inertConfig(),
        environment,
      })
      let routerResolutions = 0
      app.container.singleton('router', () => {
        routerResolutions += 1
        return new RouterFactory().merge({ app }).create()
      })

      await provider.start()

      assert.equal(routerResolutions, 0, environment)
    }
  })

  test('fail at boot when config/periscope.ts is missing', async ({ assert }) => {
    const { provider } = await createProvider()

    await assert.rejects(() => provider.ready(), PeriscopeConfigError, /config\/periscope\.ts/)
  })

  test('fail at boot naming the blocks a hand-written config skipped', async ({ assert }) => {
    const { provider } = await createProvider({ periscope: UNRESOLVED_CONFIG })

    /**
     * Only `redact` and `hooks` are absent, and the message has to say so rather than list every
     * block it knows about — "your config is wrong" sends a reader through a file that is mostly
     * fine.
     */
    await assert.rejects(
      () => provider.ready(),
      PeriscopeConfigError,
      /the redact, hooks block\(s\) are missing/
    )
  })

  test('reject a resolved config from before watcher and dashboard defaults existed', async ({
    assert,
  }) => {
    /**
     * Every block the old provider checked is still present, which is what made this stale config
     * especially dangerous: registration failed behind `safeguardAsync()` and boot appeared
     * successful while the application was left completely unwatched.
     */
    const prePhaseThreeConfig: Partial<ResolvedPeriscopeConfig> = { ...inertConfig() }
    delete prePhaseThreeConfig.watchers
    delete prePhaseThreeConfig.dashboard
    const { provider } = await createProvider({ periscope: prePhaseThreeConfig })

    try {
      await assert.rejects(
        () => provider.ready(),
        PeriscopeConfigError,
        /the watchers, dashboard block\(s\) are missing/
      )
    } finally {
      await provider.shutdown()
    }
  })

  test('build the configured store when recording is enabled', async ({ assert }) => {
    const { provider } = await createProvider({
      nodeEnv: 'development',
      periscope: defineConfig({ storage: { driver: UNBUILDABLE_DRIVER } }),
    })

    /**
     * The counterpart of the disabled test below. An enabled Periscope *must* go through
     * `createStore`, so the driver that cannot be built has to take boot down — otherwise the
     * skip-the-store optimisation would have quietly disabled durable storage for everyone.
     */
    await assert.rejects(() => provider.ready(), PeriscopeStorageError, /@adonisjs\/lucid/)
  })

  test('record through the configured store when the environment allows it', async ({ assert }) => {
    const { app, provider } = await createProvider({
      nodeEnv: 'development',
      periscope: defineConfig({ storage: { driver: 'memory' } }),
    })

    await provider.ready()

    const recorder = await app.container.make(Recorder)

    assert.isTrue(recorder.enabled)
    assert.instanceOf(recorder.store, MemoryStore)

    recorder.record(IncomingEntry.make(EntryType.EVENT, { name: 'order.placed' }))
    await recorder.flush()

    const page = await recorder.store.list()

    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].type, EntryType.EVENT)

    await provider.shutdown()
  })

  test('run configured retention shortly after ready inside a muted context', async ({
    assert,
  }) => {
    const retentionHours = 12
    const { app, provider } = await createProvider({
      periscope: defineConfig({
        storage: {
          driver: 'memory',
          retention: { hours: retentionHours, keepExceptions: true },
        },
      }),
    })

    await provider.ready()

    const recorder = await app.container.make(Recorder)
    const calls: { before: Date; keepExceptions?: boolean; muted: boolean }[] = []
    const now = Date.now()
    recorder.store.prune = async (options) => {
      calls.push({
        before: options.before,
        keepExceptions: options.keepExceptions,
        muted: BatchScope.current()?.muted === true,
      })
      return 0
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    assert.lengthOf(calls, 1)
    assert.isTrue(calls[0].muted)
    assert.isTrue(calls[0].keepExceptions)
    assert.approximately(calls[0].before.getTime(), now - retentionHours * 60 * 60 * 1_000, 1_000)

    await provider.shutdown()
  })

  test('forward per-entry retention cutoffs from the same cycle timestamp', async ({ assert }) => {
    const retentionHours = 24
    const queryHours = 3
    const { app, provider } = await createProvider({
      periscope: defineConfig({
        storage: {
          driver: 'memory',
          retention: {
            hours: retentionHours,
            perType: { query: { hours: queryHours } },
          },
        },
      }),
    })
    const recorder = await app.container.make(Recorder)
    const now = Date.now()
    let before: Date | undefined
    let queryBefore: Date | undefined
    recorder.store.prune = async (options) => {
      before = options.before
      queryBefore = options.perTypeBefore?.query
      return 0
    }

    await provider.ready()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    assert.approximately(before!.getTime(), now - retentionHours * 60 * 60 * 1_000, 1_000)
    assert.approximately(queryBefore!.getTime(), now - queryHours * 60 * 60 * 1_000, 1_000)

    await provider.shutdown()
  })

  test('skip retention while another worker holds the maintenance lease', async ({ assert }) => {
    const { app, provider } = await createProvider({
      periscope: defineConfig({
        storage: { driver: 'memory', retention: { hours: 24 } },
      }),
    })
    const recorder = await app.container.make(Recorder)
    let pruneCalls = 0
    recorder.store.prune = async () => {
      pruneCalls += 1
      return 0
    }
    await recorder.store.setFlag('maintenance-lease', 'foreign-worker', {
      expiresAt: new Date(Date.now() + 60_000),
    })

    await provider.ready()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    assert.equal(pruneCalls, 0)

    await provider.shutdown()
  })

  test('never touch the configured driver when recording is disabled', async ({ assert }) => {
    const { app, provider } = await createProvider({
      nodeEnv: 'production',
      periscope: defineConfig({
        enabledIn: ['development', 'test'],
        storage: { driver: UNBUILDABLE_DRIVER },
      }),
    })

    /**
     * The whole point: the `database` driver cannot be built here, so a provider that calls
     * `createStore` before consulting the environment gate takes the *host application* down at
     * boot — in production, because Periscope is switched off. Booting cleanly here is the proof
     * that a disabled Periscope opens no file, loads no native module and holds no connection.
     */
    await provider.ready()

    const recorder = await app.container.make(Recorder)

    assert.isFalse(recorder.enabled)
    assert.instanceOf(recorder.store, MemoryStore)

    /**
     * And it is still a working recorder rather than a stub: the watchers a host registers keep
     * calling `record()` whatever the gate said, and every one of those entries is dropped.
     */
    recorder.record(IncomingEntry.make(EntryType.EVENT, { name: 'dropped' }))
    await recorder.flush()

    const page = await recorder.store.list()

    assert.isEmpty(page.data)

    await provider.shutdown()
  })

  test('write no sqlite file when a sqlite-local Periscope is disabled', async ({ assert }) => {
    const { app, provider } = await createProvider({
      nodeEnv: 'production',
      environment: 'web',
      periscope: defineConfig({
        enabledIn: ['development', 'test'],
        storage: { driver: 'sqlite-local' },
      }),
    })

    /**
     * `sqlite-local` is the shipped default, so this is the case most applications that switch
     * Periscope off in production are actually in. Unlike `database` it cannot fail loudly — it
     * would succeed, quietly loading a native module and leaving a database file in the
     * production `tmp/` directory that nothing will ever write to. The absent file is the only
     * observable proof that the driver was never built.
     */
    const file = app.tmpPath('periscope.sqlite')
    await rm(file, { force: true })

    await provider.ready()

    const recorder = await app.container.make(Recorder)

    assert.isFalse(recorder.enabled)
    assert.instanceOf(recorder.store, MemoryStore)
    assert.isFalse(existsSync(file))

    await provider.shutdown()
  })

  test('open the configured durable store for disabled console processes', async ({ assert }) => {
    const { app, provider } = await createProvider({
      nodeEnv: 'production',
      environment: 'console',
      periscope: defineConfig({
        enabledIn: ['development', 'test'],
        storage: { driver: 'sqlite-local' },
      }),
    })
    const file = app.tmpPath('periscope.sqlite')
    await rm(file, { force: true })

    await provider.ready()

    const recorder = await app.container.make(Recorder)

    assert.isFalse(recorder.enabled)
    assert.instanceOf(recorder.store, SqliteLocalStore)

    await recorder.store.setFlag('console-maintenance', 'durable')
    await provider.shutdown()

    const reopened = new SqliteLocalStore({ path: file })

    try {
      assert.equal(await reopened.getFlag('console-maintenance'), 'durable')
    } finally {
      await reopened.close()
      await rm(file, { force: true })
    }
  })

  test('close the store on shutdown', async ({ assert }) => {
    const { app, provider } = await createProvider({ periscope: inertConfig() })

    await provider.ready()

    const recorder = await app.container.make(Recorder)
    let closed = 0

    /**
     * `MemoryStore.close()` is a no-op by nature, so the call itself is what is asserted. It
     * matters for the drivers that follow: a provider that forgets to close leaks a sqlite handle
     * or a database connection per application lifetime.
     */
    recorder.store.close = async () => {
      closed += 1
    }

    await provider.shutdown()

    assert.equal(closed, 1)
  })

  test('tear down during terminating while host services are alive and reuse it in shutdown', async ({
    assert,
  }) => {
    const { app, provider } = await createProvider({ periscope: inertConfig() })

    await provider.ready()

    const recorder = await app.container.make(Recorder)
    const store = recorder.store
    const save = store.save.bind(store)
    let hostServicesAlive = true
    let closes = 0
    const closeGate = Promise.withResolvers<void>()
    const closeStarted = Promise.withResolvers<void>()

    store.save = async (entries) => {
      assert.isTrue(hostServicesAlive, 'the final flush must run before host provider shutdown')
      await save(entries)
    }
    store.close = async () => {
      closes++
      closeStarted.resolve()
      await closeGate.promise
      assert.isTrue(hostServicesAlive, 'the store must close before host provider shutdown')
    }

    /**
     * Adonis runs terminating hooks in reverse registration order. This hook was registered after
     * the provider's hook, so its entry must still be accepted and included in the final drain.
     */
    app.terminating(() => {
      recorder.record(IncomingEntry.make(EntryType.EVENT, { name: 'late-terminating-hook' }))
    })

    const termination = app.terminate()
    await closeStarted.promise

    /**
     * Provider shutdown can begin as soon as this terminating hook is still winding down. It must
     * await that exact teardown rather than starting a second close against the same live store.
     */
    const shutdown = provider.shutdown()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    try {
      assert.equal(closes, 1)
    } finally {
      closeGate.resolve()
    }

    await Promise.all([termination, shutdown])

    const page = await store.list()

    assert.equal(closes, 1)
    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].content.name, 'late-terminating-hook')

    /**
     * Provider shutdown follows the terminating phase in a real application. Simulate Lucid now
     * being closed: reusing the teardown promise must perform no second flush or close that could
     * make a database-backed store reopen its pool.
     */
    hostServicesAlive = false
    await provider.shutdown()

    assert.equal(closes, 1)
  })

  test('swallow and report store close failures while resetting provider state', async ({
    assert,
  }) => {
    const logs: string[] = []
    const { app, provider } = await createProvider({
      nodeEnv: 'production',
      environment: 'console',
      periscope: inertConfig(),
    })
    const logger = new LoggerFactory().merge({ enabled: true }).pushLogsTo(logs).create()
    app.container.singleton('logger', () => logger as unknown as LoggerService)

    await provider.ready()

    const recorder = await app.container.make(Recorder)
    assert.isFalse(recorder.enabled)
    let closeCalls = 0
    recorder.store.close = async () => {
      closeCalls += 1
      throw new Error('close failed')
    }

    await assert.doesNotReject(() => provider.shutdown())

    assert.equal(closeCalls, 1)
    assert.lengthOf(logs, 1)

    const line: { msg?: string; err?: { message?: string } } = JSON.parse(logs[0])
    assert.equal(line.msg, 'periscope.provider.store.close')
    assert.equal(line.err?.message, 'close failed')

    safeguard('after-provider-shutdown', () => {
      throw new Error('must use the reset reporter')
    })

    assert.lengthOf(logs, 1)

    await provider.shutdown()
    assert.equal(closeCalls, 1)
  })

  test('shut down cleanly when ready never ran', async ({ assert }) => {
    const { app, provider } = await createProvider({
      periscope: defineConfig({ storage: { driver: UNBUILDABLE_DRIVER } }),
    })

    /**
     * An application can be terminated between `register()` and `ready()` — a boot that fails in
     * another provider, a command that exits early. Winding down must not be the thing that
     * *creates* the store, which the unbuildable driver would make impossible to miss.
     */
    await provider.shutdown()

    await assert.rejects(() => app.container.make(Recorder), PeriscopeStorageError)
  })

  test('report swallowed failures through a periscope.internal child logger', async ({
    assert,
  }) => {
    const logs: string[] = []
    const { app, provider } = await createProvider({ periscope: inertConfig() })

    /**
     * The factory logger is generically typed and is not a `LoggerManager`; the provider only
     * ever calls `child()` on it, which both share. Casting is the same unchecked-but-safe step
     * the app factory takes for the emitter.
     */
    const logger = new LoggerFactory().merge({ enabled: true }).pushLogsTo(logs).create()
    app.container.singleton('logger', () => logger as unknown as LoggerService)

    await provider.ready()

    safeguard('periscope.store.save', () => {
      throw new Error('the store is on fire')
    })

    assert.lengthOf(logs, 1)

    const line: { name?: string; msg?: string; err?: { message?: string } } = JSON.parse(logs[0])

    /**
     * The channel name is load-bearing rather than decorative: LogWatcher excludes
     * `periscope.internal` by name, and that exclusion is what stops a failing store from
     * recording its own error logs as entries that fail to write.
     */
    assert.equal(line.name, 'periscope.internal')
    assert.equal(line.msg, 'periscope.store.save')
    assert.equal(line.err?.message, 'the store is on fire')

    await provider.shutdown()

    safeguard('periscope.store.save', () => {
      throw new Error('after the application is gone')
    })

    /**
     * Nothing more reaches the application's logger once it has been shut down — a terminated
     * app's destination may already be closed, and a leaked binding would have this suite's
     * failures reported through a logger belonging to another one.
     */
    assert.lengthOf(logs, 1)
  })

  test('boot without a logger binding at all', async ({ assert }) => {
    const { app, provider } = await createProvider({ periscope: inertConfig() })

    /**
     * The throwaway app registers no providers, so nothing binds `logger`. Diagnostics wiring is
     * a nicety and must never be the reason a host application fails to start.
     */
    assert.isFalse(app.container.hasBinding('logger'))

    await provider.ready()

    const recorder = await app.container.make(Recorder)

    assert.isTrue(recorder.enabled)

    await provider.shutdown()
  })

  test('capture a model booted after provider boot and reuse its watcher at ready', async ({
    assert,
  }) => {
    const originalBoot = BaseModel.boot
    const { app, provider } = await createProvider({ periscope: inertConfig() })

    try {
      await provider.boot()

      const installedBoot = BaseModel.boot
      assert.notStrictEqual(installedBoot, originalBoot)
      assert.isNull(getActiveWatcher('request'))
      assert.isNull(getActiveWatcher('exception'))

      class BootWindowModel extends BaseModel {}

      BootWindowModel.boot()
      const model = new BootWindowModel()
      model.$attributes = { id: 41, state: 'before-ready' }
      await BootWindowModel.$hooks.runner('after:create').run(model)

      await provider.boot()
      await provider.ready()
      await provider.ready()

      assert.strictEqual(BaseModel.boot, installedBoot)

      const recorder = await app.container.make(Recorder)
      await recorder.flush()
      const page = await recorder.store.list({ type: EntryType.MODEL })

      assert.lengthOf(page.data, 1)
      assert.deepEqual(page.data[0].content, {
        action: 'create',
        model: 'BootWindowModel',
        primaryKey: 'id',
        primaryKeyValue: 41,
        attributes: { id: 41, state: 'before-ready' },
      })
    } finally {
      await provider.shutdown()
    }

    assert.strictEqual(BaseModel.boot, originalBoot)
  })

  test('register watchers in ready and unsubscribe them in shutdown', async ({ assert }) => {
    const { app, provider } = await createProvider({ periscope: inertConfig() })
    const emitter = (await app.container.make('emitter')) as unknown as ListenerProbe

    assert.equal(emitter.listenerCount('http:request_completed'), 0)
    assert.equal(emitter.listenerCount('db:query'), 0)
    assert.isNull(getActiveWatcher('request'))

    await provider.ready()

    assert.isAbove(emitter.listenerCount('http:request_completed'), 0)
    assert.isAbove(emitter.listenerCount('db:query'), 0)
    assert.isAbove(emitter.listenerCount('application:event'), 0)
    assert.isNotNull(getActiveWatcher('request'))

    await provider.shutdown()

    assert.equal(emitter.listenerCount('http:request_completed'), 0)
    assert.equal(emitter.listenerCount('db:query'), 0)
    assert.equal(emitter.listenerCount('application:event'), 0)
    assert.isNull(getActiveWatcher('request'))
    assert.isNull(getActiveWatcher('exception'))
  })

  test('register watchers only once when ready is called repeatedly', async ({ assert }) => {
    const { app, provider } = await createProvider({ periscope: inertConfig() })
    const emitter = (await app.container.make('emitter')) as unknown as ListenerProbe

    await provider.ready()

    const listenersAfterFirstReady = {
      request: emitter.listenerCount('http:request_completed'),
      query: emitter.listenerCount('db:query'),
      event: emitter.listenerCount('application:event'),
    }
    const requestWatcher = getActiveWatcher('request')
    const exceptionWatcher = getActiveWatcher('exception')

    await provider.ready()

    assert.deepEqual(
      {
        request: emitter.listenerCount('http:request_completed'),
        query: emitter.listenerCount('db:query'),
        event: emitter.listenerCount('application:event'),
      },
      listenersAfterFirstReady
    )
    assert.strictEqual(getActiveWatcher('request'), requestWatcher)
    assert.strictEqual(getActiveWatcher('exception'), exceptionWatcher)

    await provider.shutdown()

    /**
     * Listener counts after the second call prove it did not duplicate subscriptions; the empty
     * counts after shutdown prove it also did not replace the registry and orphan the listeners
     * belonging to the first call.
     */
    assert.equal(emitter.listenerCount('http:request_completed'), 0)
    assert.equal(emitter.listenerCount('db:query'), 0)
    assert.equal(emitter.listenerCount('application:event'), 0)
    assert.isNull(getActiveWatcher('request'))
    assert.isNull(getActiveWatcher('exception'))
  })

  test('clean watchers, finish the recorder flush, then close the store', async ({ assert }) => {
    const { app, provider } = await createProvider({ periscope: inertConfig() })
    const output: string[] = []
    const order: string[] = []
    const logger = new LoggerFactory().merge({ enabled: true }).pushLogsTo(output).create()
    app.container.singleton('logger', () => logger as unknown as LoggerService)

    await provider.ready()

    const recorder = await app.container.make(Recorder)
    const store = recorder.store
    const flush = recorder.flush.bind(recorder)

    recorder.record(IncomingEntry.make(EntryType.EVENT, { name: 'before-shutdown' }))

    /**
     * The log emitted at the flush boundary is absent from storage only when watcher cleanup has
     * already restored the logger destination. The explicit end marker proves close waits for the
     * final asynchronous recorder drain rather than merely starting it first.
     */
    recorder.flush = async (context) => {
      order.push('flush:start')
      logger.warn('after watcher cleanup')
      await flush(context)
      order.push('flush:end')
    }
    store.close = async () => {
      order.push('close')
    }

    await provider.shutdown()

    const page = await store.list()

    assert.deepEqual(order, ['flush:start', 'flush:end', 'close'])
    assert.isNotEmpty(output)
    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].type, EntryType.EVENT)
    assert.equal(page.data[0].content.name, 'before-shutdown')
  })

  test('install no emitter, process, or log listeners across disabled gates', async ({
    assert,
  }) => {
    const cases = [
      {
        name: 'master switch',
        nodeEnv: 'development',
        environment: 'web' as const,
        config: defineConfig({ enabled: false, storage: { driver: 'memory' } }),
        override: undefined,
      },
      {
        name: 'NODE_ENV gate',
        nodeEnv: 'production',
        environment: 'web' as const,
        config: inertConfig(),
        override: undefined,
      },
      {
        name: 'PERISCOPE_ENABLED override',
        nodeEnv: 'development',
        environment: 'test' as const,
        config: inertConfig(),
        override: 'false',
      },
      {
        name: 'unsupported application environment',
        nodeEnv: 'development',
        environment: 'repl' as const,
        config: inertConfig(),
        override: undefined,
      },
    ]

    for (const scenario of cases) {
      if (scenario.override === undefined) {
        delete process.env.PERISCOPE_ENABLED
      } else {
        process.env.PERISCOPE_ENABLED = scenario.override
      }

      const logs: string[] = []
      const { app, provider } = await createProvider({
        nodeEnv: scenario.nodeEnv,
        environment: scenario.environment,
        periscope: scenario.config,
      })
      const emitter = (await app.container.make('emitter')) as unknown as ListenerProbe
      const logger = new LoggerFactory().merge({ enabled: true }).pushLogsTo(logs).create()
      const originalDestination = pinoDestination(logger.pino)
      app.container.singleton('logger', () => logger as unknown as LoggerService)

      const listeners = {
        emitter: emitter.listenerCount(),
        uncaughtExceptionMonitor: process.listenerCount('uncaughtExceptionMonitor'),
        unhandledRejection: process.listenerCount('unhandledRejection'),
      }

      const originalModelBoot = BaseModel.boot
      await provider.boot()
      await provider.boot()
      await provider.ready()
      await provider.ready()

      const recorder = await app.container.make(Recorder)

      assert.isFalse(recorder.enabled, scenario.name)
      assert.instanceOf(recorder.store, MemoryStore, scenario.name)
      assert.equal(emitter.listenerCount(), listeners.emitter, scenario.name)
      assert.equal(
        process.listenerCount('uncaughtExceptionMonitor'),
        listeners.uncaughtExceptionMonitor,
        scenario.name
      )
      assert.equal(
        process.listenerCount('unhandledRejection'),
        listeners.unhandledRejection,
        scenario.name
      )
      assert.strictEqual(BaseModel.boot, originalModelBoot, scenario.name)
      assert.strictEqual(pinoDestination(logger.pino), originalDestination, scenario.name)
      assert.isNull(getActiveWatcher('request'), scenario.name)
      assert.isNull(getActiveWatcher('exception'), scenario.name)
      assert.isEmpty(logs, scenario.name)

      await provider.shutdown()
    }
  })
})
