/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { tracingChannel } from 'node:diagnostics_channel'
import { getActiveTest, test } from '@japa/runner'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import type { BatchContext } from '../../../src/types.ts'
import { EntryType } from '../../../src/types.ts'
import { RedisWatcher } from '../../../src/watchers/redis/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

const channel = tracingChannel('adonisjs.redis.command')

async function makeWatcher(captureArguments = false) {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { redis: { enabled: true, captureArguments } } })
  const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
  const watcher = new RedisWatcher({ app, emitter, config, recorder, dev: true })
  watcher.register()
  getActiveTest()?.cleanup(async () => {
    watcher.cleanup()
    await recorder.shutdown()
  })
  return watcher
}

function publish(context: BatchContext, command: object, error?: unknown) {
  BatchScope.runWith(context, () => channel.start.publish({ command }))
  BatchScope.runWith(context, () =>
    (error === undefined ? channel.end : channel.error).publish({ command, error })
  )
}

test.group('RedisWatcher', () => {
  test('record command metadata in the originating batch without arguments by default', async ({
    assert,
  }) => {
    const watcher = await makeWatcher()
    const context = BatchScope.createContext('request')
    publish(context, { name: 'get', args: ['private:key'] })

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].type, EntryType.REDIS)
    assert.deepInclude(context.buffer[0].content, { command: 'get', argumentCount: 1 })
    assert.notProperty(context.buffer[0].content, 'arguments')
    assert.isNumber(context.buffer[0].content.durationMs)
    assert.deepEqual(context.buffer[0].tags, ['command:get'])
    assert.equal(watcher.stats.recorded, 1)
  })

  test('redact every AUTH argument even when argument capture is enabled', async ({ assert }) => {
    await makeWatcher(true)
    const context = BatchScope.createContext('request')
    publish(context, { name: 'AUTH', args: ['username', 'password'] }, new Error('denied'))

    assert.deepEqual(context.buffer[0].content.arguments, ['[REDACTED]', '[REDACTED]'])
    assert.property(context.buffer[0].content, 'error')
    assert.include(context.buffer[0].tags, 'failed')
  })
})
