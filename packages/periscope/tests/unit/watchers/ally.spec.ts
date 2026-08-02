/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { AllyManager } from '@adonisjs/ally'
import { getActiveTest, test } from '@japa/runner'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import { AllyWatcher } from '../../../src/watchers/ally/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

type FakeManager = { use(provider: string): FakeDriver }
type FakeDriver = {
  redirectUrl(): Promise<string>
  user(): Promise<unknown>
  userFromToken(token: string): Promise<unknown>
  accessToken(): Promise<unknown>
}

async function makeContext(enabled = true) {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { ally: { enabled } } })
  const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
  return { app, emitter, recorder, config, dev: true }
}

function replaceUse(use: (this: unknown, provider: string) => FakeDriver): PropertyDescriptor {
  const prototype = AllyManager.prototype as unknown as Record<PropertyKey, unknown>
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'use')!
  Object.defineProperty(prototype, 'use', { ...descriptor, value: use })
  getActiveTest()?.cleanup(() => {
    Object.defineProperty(prototype, 'use', descriptor)
  })
  return descriptor
}

test.group('AllyWatcher', () => {
  test('record provider operations and retain only safe identity fields', async ({ assert }) => {
    const driver: FakeDriver = {
      async redirectUrl() {
        return 'https://provider.example/authorize?token=private'
      },
      async user() {
        return {
          id: 'user-42',
          nickName: 'riko',
          email: 'riko@example.com',
          token: { token: 'oauth-secret', refreshToken: 'refresh-secret' },
          original: { access_token: 'raw-secret' },
        }
      },
      async userFromToken(_token) {
        return { id: 84, email: 'other@example.com', accessToken: 'must-not-appear' }
      },
      async accessToken() {
        return { token: 'oauth-secret', refreshToken: 'refresh-secret' }
      },
    }
    replaceUse(() => driver)
    const fakeManager = Object.create(AllyManager.prototype) as FakeManager
    const watcher = new AllyWatcher(await makeContext())
    await watcher.register()
    getActiveTest()?.cleanup(() => watcher.cleanup())
    const wrappedUse = fakeManager.use
    const batch = BatchScope.createContext('request')

    await BatchScope.runWith(batch, async () => {
      const github = fakeManager.use('github')
      await github.redirectUrl()
      await github.user()
      await github.userFromToken('supplied-secret')
      await github.accessToken()
    })

    assert.lengthOf(batch.buffer, 4)
    assert.deepEqual(
      batch.buffer.map((entry) => ({
        type: entry.type,
        content: { ...entry.content, durationMs: typeof entry.content.durationMs },
        tags: entry.tags,
      })),
      [
        {
          type: EntryType.ALLY,
          content: { provider: 'github', operation: 'redirectUrl', durationMs: 'number' },
          tags: ['provider:github', 'op:redirectUrl'],
        },
        {
          type: EntryType.ALLY,
          content: {
            provider: 'github',
            operation: 'user',
            durationMs: 'number',
            user: { id: 'user-42', nickName: 'riko', email: 'riko@example.com' },
          },
          tags: ['provider:github', 'op:user'],
        },
        {
          type: EntryType.ALLY,
          content: {
            provider: 'github',
            operation: 'userFromToken',
            durationMs: 'number',
            user: { id: 84, email: 'other@example.com' },
          },
          tags: ['provider:github', 'op:userFromToken'],
        },
        {
          type: EntryType.ALLY,
          content: { provider: 'github', operation: 'accessToken', durationMs: 'number' },
          tags: ['provider:github', 'op:accessToken'],
        },
      ]
    )
    const json = JSON.stringify(batch.buffer.map((entry) => entry.content))
    assert.notInclude(json, 'oauth-secret')
    assert.notInclude(json, 'refresh-secret')
    assert.notInclude(json, 'supplied-secret')
    assert.notInclude(json, 'raw-secret')
    assert.deepEqual(watcher.stats, { recorded: 4, failed: 0 })

    watcher.cleanup()
    watcher.cleanup()
    assert.notStrictEqual(fakeManager.use, wrappedUse)
    assert.strictEqual(fakeManager.use('github'), driver)
  })

  test('record failures and preserve error identity', async ({ assert }) => {
    const failure = new Error('provider rejected callback')
    const driver: FakeDriver = {
      async redirectUrl() {
        throw failure
      },
      async user() {
        return {}
      },
      async userFromToken() {
        return {}
      },
      async accessToken() {
        return {}
      },
    }
    replaceUse(() => driver)
    const fakeManager = Object.create(AllyManager.prototype) as FakeManager
    const watcher = new AllyWatcher(await makeContext())
    await watcher.register()
    getActiveTest()?.cleanup(() => watcher.cleanup())
    const batch = BatchScope.createContext('request')
    let caught: unknown

    await BatchScope.runWith(batch, async () => {
      try {
        await fakeManager.use('google').redirectUrl()
      } catch (error) {
        caught = error
      }
    })

    assert.strictEqual(caught, failure)
    assert.lengthOf(batch.buffer, 1)
    assert.equal(batch.buffer[0].content.provider, 'google')
    assert.equal(batch.buffer[0].content.operation, 'redirectUrl')
    assert.equal(typeof batch.buffer[0].content.durationMs, 'number')
    assert.deepInclude(batch.buffer[0].content.error as object, {
      name: 'Error',
      message: 'provider rejected callback',
    })
    assert.deepEqual(batch.buffer[0].tags, ['provider:google', 'op:redirectUrl', 'failed'])
    assert.deepEqual(watcher.stats, { recorded: 1, failed: 1 })
  })

  test('record nothing and leave the prototype untouched when disabled', async ({ assert }) => {
    const driver: FakeDriver = {
      async redirectUrl() {
        return 'url'
      },
      async user() {
        return {}
      },
      async userFromToken() {
        return {}
      },
      async accessToken() {
        return {}
      },
    }
    replaceUse(() => driver)
    const before = AllyManager.prototype.use
    const watcher = new AllyWatcher(await makeContext(false))
    await watcher.register()

    assert.strictEqual(AllyManager.prototype.use, before)
    assert.deepEqual(watcher.stats, { recorded: 0, failed: 0 })
  })
})
