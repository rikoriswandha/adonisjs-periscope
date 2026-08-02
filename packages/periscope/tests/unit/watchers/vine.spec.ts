/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import vine from '@vinejs/vine'
import type { VineString } from '@vinejs/vine'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import type { WatcherContext } from '../../../src/watchers/context.ts'
import { VineWatcher } from '../../../src/watchers/vine/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

async function makeContext(enabled = true): Promise<WatcherContext> {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { vine: { enabled } } })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })

  return { app, emitter, recorder, config, dev: true }
}

async function makeWatcher(enabled = true) {
  const context = await makeContext(enabled)
  const watcher = new VineWatcher(context)
  await watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())
  return { context, watcher }
}

function failingSchema() {
  return vine.object({
    email: vine.string().email(),
    profile: vine.object({ name: vine.string().minLength(3) }),
  })
}

test.group('VineWatcher', () => {
  test('records real Vine validation failures with fields, rules, and messages', async ({
    assert,
  }) => {
    const { watcher } = await makeWatcher()
    const batch = BatchScope.createContext('request')

    await assert.rejects(() =>
      BatchScope.runWith(batch, () =>
        vine.validate({
          schema: failingSchema(),
          data: { email: 'not-an-email', profile: { name: 'x' } },
        })
      )
    )

    assert.lengthOf(batch.buffer, 1)
    assert.equal(batch.buffer[0].type, EntryType.VALIDATION)
    assert.deepEqual(batch.buffer[0].content, {
      errorCount: 2,
      fields: ['email', 'profile.name'],
      errors: [
        {
          field: 'email',
          rule: 'email',
          message: 'The email field must be a valid email address',
        },
        {
          field: 'profile.name',
          rule: 'minLength',
          message: 'The name field must have at least 3 characters',
          meta: { min: 3 },
        },
      ],
    })
    assert.deepEqual(batch.buffer[0].tags, ['validation', 'field:email', 'field:profile.name'])
    assert.deepEqual(watcher.stats, { recorded: 1, ignored: 0 })
  })

  test('does not record passing validation', async ({ assert }) => {
    const { watcher } = await makeWatcher()
    const batch = BatchScope.createContext('request')

    await BatchScope.runWith(batch, () =>
      vine.validate({
        schema: failingSchema(),
        data: { email: 'virk@example.com', profile: { name: 'Virk' } },
      })
    )

    assert.isEmpty(batch.buffer)
    assert.deepEqual(watcher.stats, { recorded: 0, ignored: 0 })
  })

  test('records failures returned by tryValidate', async ({ assert }) => {
    const { watcher } = await makeWatcher()
    const batch = BatchScope.createContext('request')

    const [error, result] = await BatchScope.runWith(batch, () =>
      vine.tryValidate({
        schema: vine.object({ email: vine.string().email() }),
        data: { email: 'x' },
      })
    )

    assert.instanceOf(error, Error)
    assert.isNull(result)
    assert.lengthOf(batch.buffer, 1)
    assert.deepEqual(batch.buffer[0].content, {
      errorCount: 1,
      fields: ['email'],
      errors: [
        {
          field: 'email',
          rule: 'email',
          message: 'The email field must be a valid email address',
        },
      ],
    })
    assert.deepEqual(watcher.stats, { recorded: 1, ignored: 0 })
  })

  test('caps stored errors while retaining the true failure count', async ({ assert }) => {
    const { watcher } = await makeWatcher()
    const batch = BatchScope.createContext('request')
    const fields: Record<string, VineString> = {}

    for (let index = 0; index < 55; index++) {
      fields[`field_${index}`] = vine.string()
    }

    await assert.rejects(() =>
      BatchScope.runWith(batch, () => vine.validate({ schema: vine.object(fields), data: {} }))
    )

    assert.lengthOf(batch.buffer, 1)
    assert.equal(batch.buffer[0].content.errorCount, 55)
    assert.lengthOf(batch.buffer[0].content.errors as unknown[], 50)
    assert.lengthOf(batch.buffer[0].content.fields as unknown[], 50)
    assert.lengthOf(batch.buffer[0].tags, 6)
    assert.deepEqual(watcher.stats, { recorded: 1, ignored: 5 })
  })

  test('leaves Vine untouched when disabled', async ({ assert }) => {
    const original = vine.errorReporter
    const { watcher } = await makeWatcher(false)

    assert.strictEqual(vine.errorReporter, original)
    assert.deepEqual(watcher.stats, { recorded: 0, ignored: 0 })
  })

  test('restores the original reporter and registers only once', async ({ assert }) => {
    const context = await makeContext()
    const watcher = new VineWatcher(context)
    const original = vine.errorReporter

    await watcher.register()
    const installed = vine.errorReporter
    await watcher.register()

    assert.notStrictEqual(installed, original)
    assert.strictEqual(vine.errorReporter, installed)

    watcher.cleanup()
    assert.strictEqual(vine.errorReporter, original)
    watcher.cleanup()
    assert.strictEqual(vine.errorReporter, original)
  })
})
