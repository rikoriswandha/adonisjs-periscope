/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import type { EmitterService } from '@adonisjs/core/types'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import type { WatcherContext } from '../../../src/watchers/context.ts'
import { EventWatcher } from '../../../src/watchers/event/watcher.ts'
import { GateWatcher } from '../../../src/watchers/gate/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

type AuthorizationEvent = {
  user: unknown
  action: string
  parameters: unknown[]
  response: {
    authorized: boolean
    status?: number
    message?: string
  }
}

type TestEmitter = {
  emit(event: 'authorization:finished', data: AuthorizationEvent): Promise<void>
}

async function makeContext(ignoreAbilities: string[] = []): Promise<WatcherContext> {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { gate: { ignoreAbilities } } })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })

  return { app, emitter, recorder, config, dev: true }
}

async function makeWatcher(ignoreAbilities: string[] = []) {
  const context = await makeContext(ignoreAbilities)
  const watcher = new GateWatcher(context)

  watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())

  return { context, watcher }
}

async function captureAuthorization(context: WatcherContext, event: AuthorizationEvent) {
  const batch = BatchScope.createContext('request')
  const emitter = context.emitter as unknown as TestEmitter

  await BatchScope.runWith(batch, () => emitter.emit('authorization:finished', event))
  return batch
}

test.group('GateWatcher', () => {
  test('map the shared Bouncer event into a redacted gate entry', async ({ assert }) => {
    const { context, watcher } = await makeWatcher()
    const user = { id: 42, email: 'virk@example.com', password: 'super-secret' }
    const parameters = [{ id: 7, token: 'private-token' }]
    const batch = await captureAuthorization(context, {
      user,
      action: 'PostPolicy.update',
      parameters,
      response: { authorized: false, status: 403, message: 'Post is locked' },
    })

    assert.lengthOf(batch.buffer, 1)
    assert.equal(batch.buffer[0].type, EntryType.GATE)
    assert.deepEqual(batch.buffer[0].content, {
      ability: 'PostPolicy.update',
      allowed: false,
      userId: 42,
      user: {
        id: 42,
        email: 'virk@example.com',
        password: '[REDACTED]',
      },
      args: [{ id: 7, token: '[REDACTED]' }],
      status: 403,
      message: 'Post is locked',
    })
    assert.deepEqual(batch.buffer[0].tags, [
      'ability:PostPolicy.update',
      'denied',
      'user:42',
      'status:403',
    ])
    assert.deepEqual(user, {
      id: 42,
      email: 'virk@example.com',
      password: 'super-secret',
    })
    assert.deepEqual(parameters, [{ id: 7, token: 'private-token' }])
    assert.deepEqual(watcher.stats, { recorded: 1, ignored: 0 })
  })

  test('apply ignoreAbilities as exact ability names', async ({ assert }) => {
    const { context, watcher } = await makeWatcher(['posts.view'])
    const batch = BatchScope.createContext('request')
    const emitter = context.emitter as unknown as TestEmitter

    await BatchScope.runWith(batch, async () => {
      await emitter.emit('authorization:finished', {
        user: null,
        action: 'posts.view',
        parameters: [],
        response: { authorized: true },
      })
      await emitter.emit('authorization:finished', {
        user: null,
        action: 'posts.viewAny',
        parameters: [],
        response: { authorized: true },
      })
    })

    assert.lengthOf(batch.buffer, 1)
    assert.deepEqual(batch.buffer[0].content, {
      ability: 'posts.viewAny',
      allowed: true,
      args: [],
    })
    assert.deepEqual(batch.buffer[0].tags, ['ability:posts.viewAny', 'allowed'])
    assert.deepEqual(watcher.stats, { recorded: 1, ignored: 1 })
  })

  test('serialize hostile users without guessing an unsafe identifier', async ({ assert }) => {
    const { context } = await makeWatcher()
    const user = Object.defineProperty({ email: 'guest@example.com' }, 'id', {
      enumerable: true,
      get() {
        throw new Error('id is unavailable')
      },
    })

    const batch = await captureAuthorization(context, {
      user,
      action: 'reports.read',
      parameters: [1n, user],
      response: { authorized: true },
    })

    assert.lengthOf(batch.buffer, 1)
    assert.notProperty(batch.buffer[0].content, 'userId')
    assert.deepEqual(batch.buffer[0].content.user, {
      email: 'guest@example.com',
      id: '[Getter threw: id is unavailable]',
    })
    assert.deepEqual(batch.buffer[0].content.args, [
      '1n',
      { email: 'guest@example.com', id: '[Getter threw: id is unavailable]' },
    ])
    assert.doesNotThrow(() => JSON.stringify(batch.buffer[0].content))
  })

  test('drop malformed event failures without rejecting the host emission', async ({ assert }) => {
    const { context, watcher } = await makeWatcher()
    const emitter = context.emitter as unknown as TestEmitter
    const event = {
      user: null,
      parameters: [],
      response: { authorized: true },
    } as unknown as AuthorizationEvent
    Object.defineProperty(event, 'action', {
      get() {
        throw new Error('host payload failed')
      },
    })
    const batch = BatchScope.createContext('request')

    await assert.doesNotReject(() =>
      BatchScope.runWith(batch, () => emitter.emit('authorization:finished', event))
    )
    assert.isEmpty(batch.buffer)
    assert.deepEqual(watcher.stats, { recorded: 0, ignored: 0 })
  })

  test('record authorization once when the generic event watcher is also active', async ({
    assert,
  }) => {
    const { context } = await makeWatcher()
    const eventWatcher = new EventWatcher(context)
    eventWatcher.register()
    getActiveTest()?.cleanup(() => eventWatcher.cleanup())

    const batch = await captureAuthorization(context, {
      user: { id: 'user-1' },
      action: 'dashboard.open',
      parameters: [],
      response: { authorized: true },
    })

    assert.lengthOf(batch.buffer, 1)
    assert.equal(batch.buffer[0].type, EntryType.GATE)
    assert.deepEqual(eventWatcher.stats, { recorded: 0, ignored: 1 })
  })

  test('subscribe and unsubscribe at most once while swallowing teardown failures', async ({
    assert,
  }) => {
    const context = await makeContext()
    let subscriptions = 0
    let unsubscriptions = 0
    const emitter = {
      on(event: 'authorization:finished') {
        assert.equal(event, 'authorization:finished')
        subscriptions++
        return () => {
          unsubscriptions++
          throw new Error('emitter teardown failed')
        }
      },
    } as unknown as EmitterService
    const watcher = new GateWatcher({ ...context, emitter })

    assert.doesNotThrow(() => {
      watcher.register()
      watcher.register()
      watcher.cleanup()
      watcher.cleanup()
    })
    assert.equal(subscriptions, 1)
    assert.equal(unsubscriptions, 1)
  })
})
