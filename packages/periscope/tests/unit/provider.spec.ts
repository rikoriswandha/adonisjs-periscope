/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { test } from '@japa/runner'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import type { ApplicationService, LoggerService } from '@adonisjs/core/types'

import PeriscopeProvider from '../../providers/periscope_provider.ts'
import { IncomingEntry } from '../../src/entry.ts'
import { EntryType } from '../../src/types.ts'
import { Recorder } from '../../src/recorder/recorder.ts'
import { defineConfig } from '../../src/define_config.ts'
import { safeguard, setInternalLogger } from '../../src/safeguard.ts'
import { MemoryStore } from '../../src/storage/memory_store.ts'
import { PeriscopeConfigError, PeriscopeStorageError } from '../../src/errors.ts'
import { createApp } from '../helpers/app_factory.ts'
import type { ResolvedPeriscopeConfig } from '../../src/types.ts'

/**
 * A driver `createStore` refuses to build in a bare unit-test application: nothing binds
 * `lucid.db`, so the `database` driver has no database service to borrow. It is the sharpest
 * available probe for "did the provider construct the configured store?" — naming it makes store
 * construction throw, so a code path that reaches `createStore` cannot pretend it did not.
 */
const UNBUILDABLE_DRIVER = 'database' as const

/**
 * One shape of `config/periscope.ts` that never went through `defineConfig()` — the mistake the
 * provider's resolved-config check exists to catch. `storage` and `recording` are present so the
 * error can be held to naming only what is actually missing.
 */
const UNRESOLVED_CONFIG = {
  enabled: true,
  enabledIn: ['development'],
  storage: { driver: 'memory', maxEntries: 10 },
  recording: { caps: {}, ambientRotationMs: 10_000, pausedFlagTtlMs: 5_000 },
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
  options: { periscope?: unknown; nodeEnv?: string } = {}
): Promise<{ app: ApplicationService; provider: PeriscopeProvider }> {
  process.env.NODE_ENV = options.nodeEnv ?? 'development'

  const { app } = await createApp({
    config: options.periscope === undefined ? {} : { periscope: options.periscope },
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
     * The channel name is load-bearing rather than decorative: P3.5's LogWatcher excludes
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
})
