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
import { SessionWatcher } from '../../../src/watchers/session/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

type RuntimeEmitter = { emit(event: string, payload: unknown): Promise<void> }

function session(id: string) {
  return {
    sessionId: id,
    fresh: false,
    readonly: false,
    hasBeenModified: true,
    all: () => ({ userId: 42, token: 'secret' }),
  }
}

async function makeWatcher(captureValues = false) {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { session: { enabled: true, captureValues } } })
  const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
  const watcher = new SessionWatcher({ app, emitter, config, recorder, dev: true })
  watcher.register()
  getActiveTest()?.cleanup(async () => {
    watcher.cleanup()
    await recorder.shutdown()
  })
  return { emitter: emitter as unknown as RuntimeEmitter, watcher }
}

test.group('SessionWatcher', () => {
  test('hash raw identifiers and omit values by default', async ({ assert }) => {
    const { emitter, watcher } = await makeWatcher()
    const context = BatchScope.createContext('request')
    await BatchScope.runWith(context, () =>
      emitter.emit('session:migrated', {
        fromSessionId: 'raw-old-session',
        toSessionId: 'raw-new-session',
        session: session('raw-new-session'),
      })
    )

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].type, EntryType.SESSION)
    assert.equal(context.buffer[0].content.operation, 'migrated')
    assert.lengthOf(String(context.buffer[0].content.sessionIdHash), 24)
    assert.lengthOf(String(context.buffer[0].content.fromSessionIdHash), 24)
    assert.notInclude(JSON.stringify(context.buffer[0].content), 'raw-new-session')
    assert.notInclude(JSON.stringify(context.buffer[0].content), 'raw-old-session')
    assert.notProperty(context.buffer[0].content, 'values')
    assert.equal(watcher.stats.recorded, 1)
  })

  test('capture serialised values only when explicitly enabled', async ({ assert }) => {
    const { emitter } = await makeWatcher(true)
    const context = BatchScope.createContext('request')
    await BatchScope.runWith(context, () =>
      emitter.emit('session:committed', { session: session('session-1') })
    )

    assert.deepEqual(context.buffer[0].content.values, {
      userId: 42,
      token: '[REDACTED]',
    })
  })
})
