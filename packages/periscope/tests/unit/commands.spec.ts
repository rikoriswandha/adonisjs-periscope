/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { randomUUID } from 'node:crypto'

import { getActiveTest, test } from '@japa/runner'
import { Kernel } from '@adonisjs/core/ace'

import PeriscopeClear from '../../commands/clear.ts'
import PeriscopePause from '../../commands/pause.ts'
import PeriscopePrune from '../../commands/prune.ts'
import PeriscopeResume from '../../commands/resume.ts'
import { defineConfig } from '../../src/define_config.ts'
import { IncomingEntry } from '../../src/entry.ts'
import { BatchScope } from '../../src/recorder/context.ts'
import { Recorder } from '../../src/recorder/recorder.ts'
import { MemoryStore } from '../../src/storage/memory_store.ts'
import { EntryType, Flag } from '../../src/types.ts'
import { createApp } from '../helpers/app_factory.ts'
import type { StorageDriverName, StoredEntry } from '../../src/types.ts'

let sequence = BigInt(Date.now()) * 1_000_000n

function makeStoredEntry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  sequence += 1n

  return {
    uuid: randomUUID(),
    batchId: randomUUID(),
    type: EntryType.REQUEST,
    familyHash: null,
    content: {},
    tags: [],
    shouldDisplayOnIndex: true,
    sequence,
    createdAt: new Date(),
    ...overrides,
  }
}

async function createHarness(
  pausedFlagTtlMs = 5_000,
  storageDriver: StorageDriverName = 'sqlite-local'
) {
  const config = defineConfig({
    storage: { driver: storageDriver },
    recording: { pausedFlagTtlMs },
  })
  const { app } = await createApp({ environment: 'console', config: { periscope: config } })
  const recorder = new Recorder({
    config,
    store: new MemoryStore({ maxEntries: config.storage.maxEntries }),
    enabled: false,
  })
  app.container.singleton(Recorder, () => recorder)
  const kernel = new Kernel(app)
  kernel.ui.switchMode('raw')
  getActiveTest()?.cleanup(() => recorder.shutdown())

  return { config, kernel, recorder }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

async function recordAndFlush(recorder: Recorder, message: string): Promise<void> {
  const context = BatchScope.createContext('command')

  BatchScope.runWith(context, () => {
    recorder.record(IncomingEntry.make(EntryType.LOG, { message }))
  })

  await recorder.flush(context)
}

test.group('Periscope commands', () => {
  test('hydrate prune flags and apply the default 48-hour retention window', async ({ assert }) => {
    const { kernel, recorder } = await createHarness()
    const now = Date.now()
    const old = makeStoredEntry({ createdAt: new Date(now - 49 * 60 * 60 * 1_000) })
    const fresh = makeStoredEntry({ createdAt: new Date(now - 47 * 60 * 60 * 1_000) })
    await recorder.store.save([old, fresh])

    const muted: boolean[] = []
    const prune = recorder.store.prune.bind(recorder.store)
    recorder.store.prune = async (options) => {
      muted.push(BatchScope.current()?.muted === true)
      return prune(options)
    }

    const command = await kernel.create(PeriscopePrune, [])
    await command.exec()

    command.assertSucceeded()
    command.assertLog(command.logger.prepareSuccess('Pruned 1 Periscope entry'), 'stdout')
    assert.equal(command.hours, 48)
    assert.isFalse(command.keepExceptions)
    assert.deepEqual(muted, [true])
    assert.isNull(await recorder.store.find(old.uuid))
    assert.deepEqual(await recorder.store.find(fresh.uuid), fresh)

    const metadata = PeriscopePrune.serialize()
    assert.equal(metadata.commandName, 'periscope:prune')
    assert.isTrue(metadata.options.startApp)
    assert.deepInclude(
      metadata.flags.find((flag) => flag.name === 'hours'),
      {
        flagName: 'hours',
        type: 'number',
        default: 48,
      }
    )
    assert.deepInclude(
      metadata.flags.find((flag) => flag.name === 'keepExceptions'),
      {
        flagName: 'keep-exceptions',
        type: 'boolean',
      }
    )
  })

  test('keep old exceptions when --keep-exceptions is hydrated by Ace', async ({ assert }) => {
    const { kernel, recorder } = await createHarness()
    const now = Date.now()
    const exception = makeStoredEntry({
      type: EntryType.EXCEPTION,
      createdAt: new Date(now - 25 * 60 * 60 * 1_000),
    })
    const query = makeStoredEntry({
      type: EntryType.QUERY,
      createdAt: new Date(now - 25 * 60 * 60 * 1_000),
    })
    await recorder.store.save([exception, query])

    const command = await kernel.create(PeriscopePrune, ['--hours=24', '--keep-exceptions'])
    await command.exec()

    command.assertSucceeded()
    command.assertLog(command.logger.prepareSuccess('Pruned 1 Periscope entry'), 'stdout')
    assert.equal(command.hours, 24)
    assert.isTrue(command.keepExceptions)
    assert.deepEqual(await recorder.store.find(exception.uuid), exception)
    assert.isNull(await recorder.store.find(query.uuid))
  })

  test('reject invalid --hours values without touching the store', async ({ assert }) => {
    for (const hours of ['0', '-1', 'Infinity']) {
      const { kernel, recorder } = await createHarness()
      let pruneCalls = 0
      recorder.store.prune = async () => {
        pruneCalls++
        return 0
      }

      const command = await kernel.create(PeriscopePrune, [`--hours=${hours}`])
      await command.exec()

      command.assertFailed()
      assert.instanceOf(command.error, Error)
      assert.equal(
        command.error.message,
        'The --hours flag must be a finite number greater than 0.'
      )
      assert.equal(pruneCalls, 0)
    }
  })

  test('clear entries while preserving monitored tags and flags', async ({ assert }) => {
    const { kernel, recorder } = await createHarness()
    const entry = makeStoredEntry()
    await recorder.store.save([entry])
    await recorder.store.monitorTag('important')
    await recorder.store.setFlag(Flag.PAUSED, '1')

    const muted: boolean[] = []
    const clear = recorder.store.clear.bind(recorder.store)
    recorder.store.clear = async () => {
      muted.push(BatchScope.current()?.muted === true)
      await clear()
    }

    const command = await kernel.create(PeriscopeClear, [])
    await command.exec()

    command.assertSucceeded()
    command.assertLog(command.logger.prepareSuccess('Cleared all Periscope entries'), 'stdout')
    assert.deepEqual(muted, [true])
    assert.isNull(await recorder.store.find(entry.uuid))
    assert.deepEqual(await recorder.store.monitoredTags(), ['important'])
    assert.equal(await recorder.store.getFlag(Flag.PAUSED), '1')
  })

  test('pause and resume idempotently through muted store operations', async ({ assert }) => {
    const { kernel, recorder } = await createHarness()
    const muted: { operation: 'pause' | 'resume'; value: boolean }[] = []
    const setFlag = recorder.store.setFlag.bind(recorder.store)
    const deleteFlag = recorder.store.deleteFlag.bind(recorder.store)

    recorder.store.setFlag = async (name, value, options) => {
      muted.push({ operation: 'pause', value: BatchScope.current()?.muted === true })
      await setFlag(name, value, options)
    }
    recorder.store.deleteFlag = async (name) => {
      muted.push({ operation: 'resume', value: BatchScope.current()?.muted === true })
      await deleteFlag(name)
    }

    for (let index = 0; index < 2; index++) {
      const command = await kernel.create(PeriscopePause, [])
      await command.exec()
      command.assertSucceeded()
      command.assertLog(command.logger.prepareSuccess('Paused Periscope recording'), 'stdout')
    }

    assert.equal(await recorder.store.getFlag(Flag.PAUSED), '1')

    for (let index = 0; index < 2; index++) {
      const command = await kernel.create(PeriscopeResume, [])
      await command.exec()
      command.assertSucceeded()
      command.assertLog(command.logger.prepareSuccess('Resumed Periscope recording'), 'stdout')
    }

    assert.isNull(await recorder.store.getFlag(Flag.PAUSED))
    assert.deepEqual(muted, [
      { operation: 'pause', value: true },
      { operation: 'pause', value: true },
      { operation: 'resume', value: true },
      { operation: 'resume', value: true },
    ])
  })

  test('reject maintenance commands when the resolved storage driver is memory', async ({
    assert,
  }) => {
    const { config, kernel, recorder } = await createHarness(5_000, 'memory')
    const touched: string[] = []
    recorder.store.prune = async () => {
      touched.push('prune')
      return 0
    }
    recorder.store.clear = async () => {
      touched.push('clear')
    }
    recorder.store.setFlag = async () => {
      touched.push('pause')
    }
    recorder.store.deleteFlag = async () => {
      touched.push('resume')
    }

    const commands = [
      await kernel.create(PeriscopePrune, []),
      await kernel.create(PeriscopeClear, []),
      await kernel.create(PeriscopePause, []),
      await kernel.create(PeriscopeResume, []),
    ]

    assert.equal(config.storage.driver, 'memory')

    for (const command of commands) {
      await command.exec()

      command.assertFailed()
      assert.instanceOf(command.error, Error)
      assert.include(command.error.message, 'storage.driver "memory"')
      assert.include(command.error.message, 'Set storage.driver to "sqlite-local" or "database"')
    }

    assert.deepEqual(touched, [])
  })

  test('propagate pause and resume to an enabled recorder after one cache window', async ({
    assert,
  }) => {
    const cacheWindowMs = 1
    const { config, kernel, recorder: commandRecorder } = await createHarness(cacheWindowMs)
    const recorder = new Recorder({
      config,
      store: commandRecorder.store,
      enabled: true,
    })
    getActiveTest()?.cleanup(() => recorder.shutdown())
    recorder.start()

    await recordAndFlush(recorder, 'before pause')
    await tick()
    const beforePauseCounts = await recorder.store.counts()
    assert.equal(beforePauseCounts[EntryType.LOG], 1)

    const pause = await kernel.create(PeriscopePause, [])
    await pause.exec()
    pause.assertSucceeded()
    assert.isFalse(recorder.paused)

    await sleep(cacheWindowMs + 1)
    void recorder.paused
    await tick()
    assert.isTrue(recorder.paused)

    await recordAndFlush(recorder, 'while paused')
    const pausedCounts = await recorder.store.counts()
    assert.equal(pausedCounts[EntryType.LOG], 1)

    const resume = await kernel.create(PeriscopeResume, [])
    await resume.exec()
    resume.assertSucceeded()
    assert.isTrue(recorder.paused)

    await sleep(cacheWindowMs + 1)
    void recorder.paused
    await tick()
    assert.isFalse(recorder.paused)

    await recordAndFlush(recorder, 'after resume')
    const resumedCounts = await recorder.store.counts()
    assert.equal(resumedCounts[EntryType.LOG], 2)
  })

  test('fail through BaseCommand without reporting success when storage rejects', async ({
    assert,
  }) => {
    const { kernel, recorder } = await createHarness()
    const failure = new Error('clear failed')
    recorder.store.clear = async () => {
      throw failure
    }

    const command = await kernel.create(PeriscopeClear, [])
    await command.exec()

    command.assertFailed()
    assert.strictEqual(command.error, failure)
    assert.notInclude(
      kernel.ui.logger.getLogs().map(({ message }) => message),
      command.logger.prepareSuccess('Cleared all Periscope entries')
    )
  })
})
