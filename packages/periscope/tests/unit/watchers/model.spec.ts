/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { BaseModel } from '@adonisjs/lucid/orm'
import { getActiveTest, test } from '@japa/runner'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import { ModelWatcher } from '../../../src/watchers/model/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

async function makeWatcher(captureDirty = false) {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { model: { captureDirty } } })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const watcher = new ModelWatcher({ app, emitter, recorder, config, dev: true })

  await watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())

  return watcher
}

test.group('ModelWatcher', () => {
  test('records create, update, and delete through Lucid hooks with pre-hydration dirty data', async ({
    assert,
  }) => {
    await makeWatcher(true)

    class Account extends BaseModel {}

    const account = new Account()
    account.$attributes = { id: 7, email: 'before@example.com' }
    account.$isPersisted = true
    account.$hydrateOriginals()

    const context = BatchScope.createContext('request')
    await BatchScope.runWith(context, async () => {
      await Account.$hooks.runner('after:create').run(account)

      account.$attributes.email = 'after@example.com'
      await Account.$hooks.runner('before:update').run(account)
      account.$hydrateOriginals()
      assert.deepEqual(account.$dirty, {})
      await Account.$hooks.runner('after:update').run(account)

      await Account.$hooks.runner('after:delete').run(account)
    })

    assert.deepEqual(
      context.buffer.map((entry) => entry.type),
      [EntryType.MODEL, EntryType.MODEL, EntryType.MODEL]
    )
    assert.deepEqual(context.buffer[0].content, {
      action: 'create',
      model: 'Account',
      primaryKey: 'id',
      primaryKeyValue: 7,
      attributes: { id: 7, email: 'before@example.com' },
    })
    assert.deepEqual(context.buffer[1].content, {
      action: 'update',
      model: 'Account',
      primaryKey: 'id',
      primaryKeyValue: 7,
      attributes: { id: 7, email: 'after@example.com' },
      dirty: { email: 'after@example.com' },
    })
    assert.deepEqual(context.buffer[2].content, {
      action: 'delete',
      model: 'Account',
      primaryKey: 'id',
      primaryKeyValue: 7,
      attributes: { id: 7, email: 'after@example.com' },
    })
    assert.deepEqual(context.buffer[1].tags, ['model:Account', 'action:update'])
  })

  test('attaches one stable hook per model and does not guess Periscope model exclusions', async ({
    assert,
  }) => {
    const watcher = await makeWatcher()
    await watcher.register()

    class PeriscopeEntry extends BaseModel {}

    PeriscopeEntry.boot()
    PeriscopeEntry.boot()
    const model = new PeriscopeEntry()
    model.$attributes = { id: 11, payload: 'application-owned' }

    const context = BatchScope.createContext('request')
    await BatchScope.runWith(context, () => PeriscopeEntry.$hooks.runner('after:create').run(model))

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].content.model, 'PeriscopeEntry')
    assert.deepEqual(context.buffer[0].tags, ['model:PeriscopeEntry', 'action:create'])
  })

  test('restores BaseModel.boot while leaving host hooks live and watcher hooks inert', async ({
    assert,
  }) => {
    const originalBoot = BaseModel.boot
    const watcher = await makeWatcher()

    assert.notStrictEqual(BaseModel.boot, originalBoot)

    class HostModel extends BaseModel {}

    const model = new HostModel()
    model.$attributes = { id: 1 }
    let hostCalls = 0
    HostModel.after('create', () => {
      hostCalls++
    })

    watcher.cleanup()
    watcher.cleanup()
    assert.strictEqual(BaseModel.boot, originalBoot)

    const context = BatchScope.createContext('request')
    await BatchScope.runWith(context, () => HostModel.$hooks.runner('after:create').run(model))

    assert.equal(hostCalls, 1)
    assert.lengthOf(context.buffer, 0)
  })

  test('safe-serializes hostile model attributes without rejecting the Lucid hook', async ({
    assert,
  }) => {
    await makeWatcher()

    class HostileModel extends BaseModel {}

    const model = new HostileModel()
    model.$attributes = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('application getter failed')
        },
      }
    )

    const context = BatchScope.createContext('request')
    await assert.doesNotReject(() =>
      BatchScope.runWith(context, () => HostileModel.$hooks.runner('after:create').run(model))
    )

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].content.attributes, '[Unserializable]')
  })
})
