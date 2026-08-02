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
import type { WatcherContext } from '../../../src/watchers/context.ts'
import { I18nWatcher } from '../../../src/watchers/i18n/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

type MissingTranslationEvent = {
  locale: string
  identifier: string
  hasFallback: boolean
}

type TestEmitter = {
  emit(event: 'i18n:missing:translation', payload: MissingTranslationEvent): Promise<void>
}

async function makeWatcher(enabled = true) {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { i18n: { enabled } } })
  const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
  const context: WatcherContext = { app, emitter, recorder, config, dev: true }
  const watcher = new I18nWatcher(context)
  watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())
  return { context, watcher }
}

async function emitMissing(context: WatcherContext, payload: MissingTranslationEvent) {
  const batch = BatchScope.createContext('request')
  await BatchScope.runWith(batch, () =>
    (context.emitter as unknown as TestEmitter).emit('i18n:missing:translation', payload)
  )
  return batch
}

test.group('I18nWatcher', () => {
  test('record the real missing translation event shape', async ({ assert }) => {
    const { context, watcher } = await makeWatcher()
    const batch = await emitMissing(context, {
      locale: 'fr',
      identifier: 'messages.checkout.title',
      hasFallback: true,
    })

    assert.lengthOf(batch.buffer, 1)
    assert.equal(batch.buffer[0].type, EntryType.I18N)
    assert.deepEqual(batch.buffer[0].content, {
      locale: 'fr',
      identifier: 'messages.checkout.title',
      hasFallback: true,
    })
    assert.deepEqual(batch.buffer[0].tags, ['locale:fr', 'missing-translation'])
    assert.deepEqual(watcher.stats, { recorded: 1, ignored: 0 })
  })

  test('ignore malformed payloads and unsubscribe idempotently', async ({ assert }) => {
    const { context, watcher } = await makeWatcher()
    const emitter = context.emitter as unknown as TestEmitter
    const batch = BatchScope.createContext('request')

    await BatchScope.runWith(batch, () =>
      emitter.emit('i18n:missing:translation', {
        locale: 42,
        identifier: 'messages.title',
        hasFallback: false,
      } as unknown as MissingTranslationEvent)
    )
    assert.isEmpty(batch.buffer)
    assert.deepEqual(watcher.stats, { recorded: 0, ignored: 1 })

    watcher.cleanup()
    watcher.cleanup()
    const afterCleanup = await emitMissing(context, {
      locale: 'en',
      identifier: 'messages.after',
      hasFallback: false,
    })
    assert.isEmpty(afterCleanup.buffer)
  })

  test('record nothing when disabled', async ({ assert }) => {
    const { context, watcher } = await makeWatcher(false)
    const batch = await emitMissing(context, {
      locale: 'en',
      identifier: 'messages.disabled',
      hasFallback: false,
    })

    assert.isEmpty(batch.buffer)
    assert.deepEqual(watcher.stats, { recorded: 0, ignored: 0 })
  })
})
