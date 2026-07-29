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
import { HealthCheckWatcher } from '../../../src/watchers/health_check/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

class StubHealthChecks {
  async run() {
    return {
      isHealthy: false,
      status: 'error',
      checks: [
        {
          name: 'Database connection',
          status: 'error',
          durationMs: 12.5,
          message: 'https://db.test/status?password=hunter2&safe=yes',
        },
        {
          name: 'Memory heap',
          status: 'ok',
          message: 'Heap usage is under defined thresholds',
        },
      ],
    }
  }
}

async function makeWatcher(
  loader: () => Promise<unknown> = async () => ({ HealthChecks: StubHealthChecks })
) {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { health_check: { enabled: true } } })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const watcher = new HealthCheckWatcher({ app, emitter, recorder, config, dev: true }, loader)

  await watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())
  return watcher
}

test.group('HealthCheckWatcher', () => {
  test('patches HealthChecks.run and records a bounded per-check report', async ({ assert }) => {
    const originalRun = StubHealthChecks.prototype.run
    const watcher = await makeWatcher()
    await watcher.register()

    assert.notStrictEqual(StubHealthChecks.prototype.run, originalRun)

    const context = BatchScope.createContext('request')
    const healthChecks = new StubHealthChecks()
    const report = await BatchScope.runWith(context, () => healthChecks.run())

    assert.isFalse(report.isHealthy)
    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].type, EntryType.HEALTH_CHECK)
    assert.deepEqual(context.buffer[0].content, {
      status: 'error',
      checks: [
        {
          name: 'Database connection',
          status: 'error',
          durationMs: 12.5,
          message: 'https://db.test/status?[REDACTED]&safe=yes',
        },
        {
          name: 'Memory heap',
          status: 'ok',
          message: 'Heap usage is under defined thresholds',
        },
      ],
    })
    assert.deepEqual(context.buffer[0].tags, ['failed', 'status:error'])
    assert.equal(watcher.stats.recorded, 1)

    watcher.cleanup()
    watcher.cleanup()
    assert.strictEqual(StubHealthChecks.prototype.run, originalRun)

    await BatchScope.runWith(context, () => healthChecks.run())
    assert.lengthOf(context.buffer, 1)
  })

  test('is a silent no-op when the health module is absent', async ({ assert }) => {
    const originalRun = StubHealthChecks.prototype.run
    const watcher = await makeWatcher(async () => {
      throw Object.assign(new Error("Cannot find package '@adonisjs/core'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })

    await assert.doesNotReject(() => watcher.register())
    assert.strictEqual(StubHealthChecks.prototype.run, originalRun)
    assert.equal(watcher.stats.recorded, 0)
  })
})
