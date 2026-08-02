/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { setTimeout } from 'node:timers/promises'
import { getActiveTest, test } from '@japa/runner'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import { LockWatcher } from '../../../src/watchers/lock/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

type TestContainer = { singleton(binding: string, resolver: () => unknown): void }
type AcquireBehavior = 'fast' | 'slow' | 'denied' | 'timeout'

class StubLock {
  behavior: AcquireBehavior = 'fast'
  readonly timeoutError = Object.assign(new Error('Lock acquisition timeout'), {
    code: 'E_LOCK_TIMEOUT',
  })

  async acquire(): Promise<boolean> {
    if (this.behavior === 'slow') await setTimeout(12)
    if (this.behavior === 'denied') return false
    if (this.behavior === 'timeout') throw this.timeoutError
    return true
  }

  async acquireImmediately(): Promise<boolean> {
    return this.acquire()
  }
}

class StubLockManager {
  constructor(readonly lock: StubLock) {}

  createLock(_name: string, _ttl?: number): StubLock {
    return this.lock
  }
}

async function makeWatcher(manager: object, enabled = true, contentionMs = 8) {
  const { app, emitter } = await createApp()
  const config = defineConfig({
    storage: { driver: 'memory' },
    watchers: { lock: { enabled, contentionMs } },
  })
  const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
  ;(app.container as unknown as TestContainer).singleton('lock.manager', () => manager)
  const watcher = new LockWatcher({ app, emitter, recorder, config, dev: true })
  await watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())
  return watcher
}

test.group('LockWatcher', () => {
  test('records timeouts unchanged, ignores fast acquisition, and marks contention', async ({
    assert,
  }) => {
    const lock = new StubLock()
    const manager = new StubLockManager(lock)
    const originalCreateLock = manager.createLock
    const originalAcquire = lock.acquire
    const originalAcquireImmediately = lock.acquireImmediately
    const watcher = await makeWatcher(manager)
    const resolved = manager.createLock('invoice:42', 5_000)

    assert.notStrictEqual(manager.createLock, originalCreateLock)
    assert.notStrictEqual(resolved.acquire, originalAcquire)
    assert.notStrictEqual(resolved.acquireImmediately, originalAcquireImmediately)

    const fastBatch = BatchScope.createContext('request')
    await BatchScope.runWith(fastBatch, () => resolved.acquire())
    assert.lengthOf(fastBatch.buffer, 0)

    lock.behavior = 'slow'
    const slowBatch = BatchScope.createContext('request')
    await BatchScope.runWith(slowBatch, () => resolved.acquire())
    assert.lengthOf(slowBatch.buffer, 1)
    assert.equal(slowBatch.buffer[0].type, EntryType.LOCK)
    assert.equal(slowBatch.buffer[0].content.key, 'invoice:42')
    assert.equal(slowBatch.buffer[0].content.action, 'acquired')
    assert.equal(slowBatch.buffer[0].content.ttlMs, 5_000)
    assert.isAtLeast(slowBatch.buffer[0].content.waitedMs as number, 8)
    assert.deepEqual(slowBatch.buffer[0].tags, ['key:invoice:42', 'acquired', 'contention'])

    lock.behavior = 'timeout'
    const timeoutBatch = BatchScope.createContext('request')
    let caught: unknown
    try {
      await BatchScope.runWith(timeoutBatch, () => resolved.acquire())
    } catch (error) {
      caught = error
    }
    assert.strictEqual(caught, lock.timeoutError)
    assert.lengthOf(timeoutBatch.buffer, 1)
    assert.equal(timeoutBatch.buffer[0].content.action, 'timeout')
    assert.deepEqual(timeoutBatch.buffer[0].tags, ['key:invoice:42', 'timeout'])
    assert.equal(watcher.stats.recorded, 2)

    watcher.cleanup()
    watcher.cleanup()
    assert.strictEqual(manager.createLock, originalCreateLock)
    assert.strictEqual(lock.acquire, originalAcquire)
    assert.strictEqual(lock.acquireImmediately, originalAcquireImmediately)
  })

  test('records false acquisition as denied', async ({ assert }) => {
    const lock = new StubLock()
    const manager = new StubLockManager(lock)
    await makeWatcher(manager)
    const resolved = manager.createLock('job:one')
    lock.behavior = 'denied'
    const batch = BatchScope.createContext('request')

    assert.isFalse(await BatchScope.runWith(batch, () => resolved.acquireImmediately()))
    assert.lengthOf(batch.buffer, 1)
    assert.equal(batch.buffer[0].content.action, 'denied')
    assert.deepEqual(batch.buffer[0].tags, ['key:job:one', 'denied'])
  })

  test('does not patch while disabled', async ({ assert }) => {
    const lock = new StubLock()
    const manager = new StubLockManager(lock)
    const originalCreateLock = manager.createLock
    const watcher = await makeWatcher(manager, false)

    assert.strictEqual(manager.createLock, originalCreateLock)
    assert.deepEqual(watcher.stats, { recorded: 0, patched: 0 })
    assert.doesNotThrow(() => watcher.cleanup())
  })
})
