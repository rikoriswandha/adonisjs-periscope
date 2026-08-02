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
import { LimiterWatcher } from '../../../src/watchers/limiter/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

type TestContainer = { singleton(binding: string, resolver: () => unknown): void }

class ThrottleError extends Error {
  code = 'E_TOO_MANY_REQUESTS'
  status = 429

  constructor(readonly response: { limit: number; remaining: number; availableIn: number }) {
    super('Too many requests')
  }
}

class StubLimiter {
  readonly name = 'redis'
  readonly requests = 5
  reject = false

  async consume(_key: string): Promise<{ remaining: number }> {
    if (this.reject) throw new ThrottleError({ limit: 5, remaining: 0, availableIn: 2 })
    return { remaining: 4 }
  }

  async attempt(key: string, callback: () => unknown): Promise<unknown> {
    try {
      await this.consume(key)
      return callback()
    } catch (error) {
      if (error instanceof ThrottleError) return undefined
      throw error
    }
  }
}

class StubLimiterManager {
  constructor(readonly limiter: StubLimiter) {}

  use(_store: string, _options: object): StubLimiter {
    return this.limiter
  }
}

async function makeWatcher(manager: object, enabled = true) {
  const { app, emitter } = await createApp()
  const config = defineConfig({
    storage: { driver: 'memory' },
    watchers: { limiter: { enabled } },
  })
  const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
  ;(app.container as unknown as TestContainer).singleton('limiter.manager', () => manager)
  const watcher = new LimiterWatcher({ app, emitter, recorder, config, dev: true })
  await watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())
  return watcher
}

test.group('LimiterWatcher', () => {
  test('records rejected consumption metadata and preserves the throttle error', async ({
    assert,
  }) => {
    const limiter = new StubLimiter()
    const manager = new StubLimiterManager(limiter)
    const originalUse = manager.use
    const originalConsume = limiter.consume
    const watcher = await makeWatcher(manager)

    const resolved = manager.use('redis', { requests: 5, duration: 60 })
    assert.notStrictEqual(manager.use, originalUse)
    assert.notStrictEqual(resolved.consume, originalConsume)

    const successBatch = BatchScope.createContext('request')
    await BatchScope.runWith(successBatch, () => resolved.consume('user:42'))
    assert.lengthOf(successBatch.buffer, 0)

    limiter.reject = true
    const rejectedBatch = BatchScope.createContext('request')
    const thrown = new Promise<unknown>((resolve) => {
      BatchScope.runWith(rejectedBatch, () => resolved.consume('user:42')).catch(resolve)
    })
    const error = await thrown

    assert.instanceOf(error, ThrottleError)
    assert.lengthOf(rejectedBatch.buffer, 1)
    assert.equal(rejectedBatch.buffer[0].type, EntryType.RATE_LIMIT)
    assert.deepEqual(rejectedBatch.buffer[0].content, {
      key: 'user:42',
      action: 'consume',
      limit: 5,
      remaining: 0,
      retryAfterMs: 2000,
      store: 'redis',
    })
    assert.deepEqual(rejectedBatch.buffer[0].tags, ['key:user:42', 'rejected'])
    assert.equal(watcher.stats.recorded, 1)

    watcher.cleanup()
    watcher.cleanup()
    assert.strictEqual(manager.use, originalUse)
    assert.strictEqual(limiter.consume, originalConsume)
  })

  test('records an attempt denial once without treating an undefined callback result as denial', async ({
    assert,
  }) => {
    const limiter = new StubLimiter()
    const manager = new StubLimiterManager(limiter)
    await makeWatcher(manager)
    const resolved = manager.use('redis', { requests: 5 })
    const batch = BatchScope.createContext('request')

    await BatchScope.runWith(batch, () => resolved.attempt('success', () => undefined))
    assert.lengthOf(batch.buffer, 0)

    limiter.reject = true
    await BatchScope.runWith(batch, () => resolved.attempt('rejected', () => 'unreachable'))
    assert.lengthOf(batch.buffer, 1)
    assert.equal(batch.buffer[0].content.action, 'attempt')
    assert.equal(batch.buffer[0].content.retryAfterMs, 2_000)
  })

  test('does not patch while disabled or when the optional binding shape is unsupported', async ({
    assert,
  }) => {
    const limiter = new StubLimiter()
    const manager = new StubLimiterManager(limiter)
    const originalUse = manager.use
    const watcher = await makeWatcher(manager, false)

    assert.strictEqual(manager.use, originalUse)
    assert.deepEqual(watcher.stats, { recorded: 0, patched: 0 })
    assert.doesNotThrow(() => watcher.cleanup())
  })
})
