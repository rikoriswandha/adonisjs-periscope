/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { getActiveTest, test } from '@japa/runner'

import { dump } from '../../../src/dump.ts'
import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType, Flag } from '../../../src/types.ts'
import { getActiveWatcher } from '../../../src/watchers/active.ts'
import { DumpWatcher } from '../../../src/watchers/dump/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

async function makeWatcher(open: boolean = false) {
  const { app, emitter } = await createApp()
  const config = defineConfig({})
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const watcher = new DumpWatcher({ app, emitter, recorder, config, dev: true })

  if (open) {
    await store.setFlag(Flag.DUMP_OPEN, '1')
  }

  await watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())

  return { recorder, store, watcher }
}

test.group('DumpWatcher and dump()', () => {
  test('return the first value and stay inert while the dashboard flag is closed', async ({
    assert,
  }) => {
    await makeWatcher()
    const context = BatchScope.createContext('request')
    const first = { id: 42 }

    const returned = BatchScope.runWith(context, () => dump(first, 'ignored'))

    assert.strictEqual(returned, first)
    assert.lengthOf(context.buffer, 0)
  })

  test('serialise heterogeneous values and capture the external caller while open', async ({
    assert,
  }) => {
    const { watcher } = await makeWatcher(true)
    const context = BatchScope.createContext('request')
    const cyclic: Record<string, unknown> = { value: 73 }
    cyclic.self = cyclic

    const returned = BatchScope.runWith(context, () => dump('first', cyclic, 99n))

    assert.equal(returned, 'first')
    assert.isTrue(watcher.active)
    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].type, EntryType.DUMP)
    assert.deepEqual(context.buffer[0].content.values, [
      'first',
      { value: 73, self: '[Circular]' },
      '99n',
    ])

    const caller = context.buffer[0].content.caller
    if (caller === null || typeof caller !== 'object') {
      throw new Error('Expected dump entry to include its caller')
    }

    assert.match(String('file' in caller ? caller.file : ''), /dump\.spec\.ts$/)
    assert.isAbove(Number('line' in caller ? caller.line : 0), 0)
    assert.isAbove(Number('column' in caller ? caller.column : 0), 0)
  })

  test('observe a flag opened after registration on the bounded poll', async ({ assert }) => {
    const { store, watcher } = await makeWatcher()
    await store.setFlag(Flag.DUMP_OPEN, '1')
    await sleep(1_100)

    const context = BatchScope.createContext('request')
    BatchScope.runWith(context, () => dump('after-poll'))

    assert.isTrue(watcher.active)
    assert.lengthOf(context.buffer, 1)
  })

  test('observe an active client lease on the bounded poll', async ({ assert }) => {
    const { store, watcher } = await makeWatcher()
    await store.setFlag(`${Flag.DUMP_OPEN}:client-a`, '1')
    await sleep(1_100)

    const context = BatchScope.createContext('request')
    BatchScope.runWith(context, () => dump('leased'))

    assert.isTrue(watcher.active)
    assert.lengthOf(context.buffer, 1)
  })

  test('fail closed when refreshing an active watcher rejects', async ({ assert }) => {
    const { store, watcher } = await makeWatcher(true)
    store.hasFlagWithPrefix = async () => {
      throw new Error('flag read failed')
    }
    await sleep(1_100)

    const context = BatchScope.createContext('request')
    BatchScope.runWith(context, () => dump('after-failure'))

    assert.isFalse(watcher.active)
    assert.lengthOf(context.buffer, 0)
  })

  test('never throw when recording diagnostics fails', async ({ assert }) => {
    const { recorder } = await makeWatcher(true)
    recorder.record = () => {
      throw new Error('record failed')
    }

    assert.doesNotThrow(() => dump('host-value'))
    assert.equal(dump('still-returned'), 'still-returned')
  })

  test('clear the rendezvous, timer state, and synchronous gate during cleanup', async ({
    assert,
  }) => {
    const { watcher } = await makeWatcher(true)
    watcher.cleanup()
    watcher.cleanup()

    const context = BatchScope.createContext('request')
    assert.doesNotThrow(() => BatchScope.runWith(context, () => dump('after-cleanup')))
    assert.isFalse(watcher.active)
    assert.isNull(getActiveWatcher('dump'))
    assert.lengthOf(context.buffer, 0)
  })
})
