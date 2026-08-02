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
import { DriveWatcher } from '../../../src/watchers/drive/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

type TestContainer = {
  singleton(binding: string, resolver: () => unknown): void
}

type FakeDisk = {
  put(key: string, contents: string): Promise<string>
  get(key: string): Promise<Uint8Array>
  copy(source: string, destination: string): Promise<void>
  delete(key: string): Promise<void>
}

async function makeWatcher(manager: object | undefined, enabled = true) {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { drive: { enabled } } })
  const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
  if (manager !== undefined) {
    ;(app.container as unknown as TestContainer).singleton('drive.manager', () => manager)
  }
  const watcher = new DriveWatcher({ app, emitter, recorder, config, dev: true })
  await watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())
  return watcher
}

test.group('DriveWatcher', () => {
  test('record disk operations without retaining contents', async ({ assert }) => {
    const disk: FakeDisk = {
      async put(key, _contents) {
        return key
      },
      async get() {
        return new Uint8Array([1, 2, 3])
      },
      async copy() {},
      async delete() {},
    }
    const manager = {
      use(_name?: string) {
        return disk
      },
    }
    const originalUse = manager.use
    const originalPut = disk.put
    const watcher = await makeWatcher(manager)
    const batch = BatchScope.createContext('request')

    await BatchScope.runWith(batch, async () => {
      const selected = manager.use('s3')
      await selected.put('private/report.txt', 'secret contents')
      await selected.get('private/report.txt')
      await selected.copy('private/report.txt', 'archive/report.txt')
    })

    assert.lengthOf(batch.buffer, 3)
    assert.deepEqual(
      batch.buffer.map((entry) => ({
        type: entry.type,
        content: { ...entry.content, durationMs: typeof entry.content.durationMs },
        tags: entry.tags,
      })),
      [
        {
          type: EntryType.DRIVE,
          content: {
            operation: 'put',
            key: 'private/report.txt',
            disk: 's3',
            durationMs: 'number',
            sizeBytes: 15,
          },
          tags: ['op:put', 'disk:s3'],
        },
        {
          type: EntryType.DRIVE,
          content: {
            operation: 'get',
            key: 'private/report.txt',
            disk: 's3',
            durationMs: 'number',
          },
          tags: ['op:get', 'disk:s3'],
        },
        {
          type: EntryType.DRIVE,
          content: {
            operation: 'copy',
            key: 'private/report.txt',
            destination: 'archive/report.txt',
            disk: 's3',
            durationMs: 'number',
          },
          tags: ['op:copy', 'disk:s3'],
        },
      ]
    )
    assert.notInclude(JSON.stringify(batch.buffer.map((entry) => entry.content)), 'secret contents')
    assert.deepEqual(watcher.stats, { recorded: 3, failed: 0 })

    watcher.cleanup()
    watcher.cleanup()
    assert.strictEqual(manager.use, originalUse)
    assert.strictEqual(disk.put, originalPut)
  })

  test('record failures and rethrow the exact disk error', async ({ assert }) => {
    const failure = new Error('storage offline')
    const disk: FakeDisk = {
      async put(key) {
        return key
      },
      async get() {
        return new Uint8Array()
      },
      async copy() {},
      async delete() {
        throw failure
      },
    }
    const manager = {
      use() {
        return disk
      },
    }
    const watcher = await makeWatcher(manager)
    const batch = BatchScope.createContext('request')
    let caught: unknown

    await BatchScope.runWith(batch, async () => {
      try {
        await manager.use().delete('documents/a.pdf')
      } catch (error) {
        caught = error
      }
    })

    assert.strictEqual(caught, failure)
    assert.lengthOf(batch.buffer, 1)
    assert.equal(batch.buffer[0].content.operation, 'delete')
    assert.equal(batch.buffer[0].content.key, 'documents/a.pdf')
    assert.equal(typeof batch.buffer[0].content.durationMs, 'number')
    assert.deepInclude(batch.buffer[0].content.error as object, {
      name: 'Error',
      message: 'storage offline',
    })
    assert.deepEqual(batch.buffer[0].tags, ['op:delete', 'failed'])
    assert.deepEqual(watcher.stats, { recorded: 1, failed: 1 })
  })

  test('no-op for an absent binding or disabled config', async ({ assert }) => {
    const disk: FakeDisk = {
      async put(key) {
        return key
      },
      async get() {
        return new Uint8Array()
      },
      async copy() {},
      async delete() {},
    }
    const manager = {
      use() {
        return disk
      },
    }
    const originalUse = manager.use
    const absent = await makeWatcher(undefined)
    const disabled = await makeWatcher(manager, false)

    assert.deepEqual(absent.stats, { recorded: 0, failed: 0 })
    assert.deepEqual(disabled.stats, { recorded: 0, failed: 0 })
    assert.strictEqual(manager.use, originalUse)
  })
})
