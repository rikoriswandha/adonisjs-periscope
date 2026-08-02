/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { setTimeout as delay } from 'node:timers/promises'

import { getActiveTest, test } from '@japa/runner'

import { defineConfig } from '../../../src/define_config.ts'
import { IncomingEntry } from '../../../src/entry.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import {
  assertNotRecorded,
  assertRecorded,
  clearRecorded,
  findEntries,
  flushAndWait,
} from '../../../src/testing/index.ts'
import { EntryType } from '../../../src/types.ts'
import type { StoredEntry } from '../../../src/types.ts'

function createRecorder(applicationName: string = 'testing') {
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({
    config: defineConfig({ applicationName }),
    store,
    enabled: true,
  })
  getActiveTest()?.cleanup(() => recorder.shutdown())

  return { recorder, store }
}

function storedEntry(uuid: string, application: string, sequence: bigint): StoredEntry {
  return {
    uuid,
    batchId: `batch-${uuid}`,
    application,
    type: EntryType.LOG,
    familyHash: null,
    content: { message: uuid },
    tags: [],
    shouldDisplayOnIndex: true,
    sequence,
    createdAt: new Date(),
  }
}

test.group('Periscope testing helpers', () => {
  test('flushAndWait resolves after an entry lands during polling', async ({ assert }) => {
    const { recorder, store } = createRecorder()
    const recordLater = delay(20).then(() => store.save([storedEntry('settled', 'testing', 1n)]))

    const entries = await flushAndWait(
      recorder,
      (current) => current.some((entry) => entry.content.message === 'settled'),
      { timeoutMs: 250, intervalMs: 5 }
    )
    await recordLater

    assert.isTrue(entries.some((entry) => entry.content.message === 'settled'))
  })

  test('assertRecorded matches type and every requested tag', async ({ assert }) => {
    const { recorder } = createRecorder()
    recorder.record(
      IncomingEntry.make(EntryType.QUERY, { sql: 'select 1' }).withTags('slow', 'tenant:42')
    )

    const matches = await assertRecorded(
      recorder,
      { type: EntryType.QUERY, tags: ['slow', 'tenant:42'] },
      { timeoutMs: 100, intervalMs: 5 }
    )

    assert.lengthOf(matches, 1)
    assert.equal(matches[0]!.type, EntryType.QUERY)
    assert.includeMembers(matches[0]!.tags, ['slow', 'tenant:42'])
    assert.lengthOf(await findEntries(recorder, { tags: ['missing'] }), 0)
  })

  test('assertNotRecorded holds the settling window when nothing matches', async ({ assert }) => {
    const { recorder } = createRecorder()
    recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'allowed' }))

    await assert.doesNotReject(() =>
      assertNotRecorded(recorder, { type: EntryType.EXCEPTION }, { timeoutMs: 30, intervalMs: 5 })
    )
  })

  test('assertNotRecorded reports matching entry types and tags', async ({ assert }) => {
    const { recorder } = createRecorder()
    recorder.record(IncomingEntry.make(EntryType.EXCEPTION).withTags('reportable', 'tenant:42'))

    await assert.rejects(
      () =>
        assertNotRecorded(
          recorder,
          { type: EntryType.EXCEPTION, tags: ['reportable'] },
          { timeoutMs: 100, intervalMs: 5 }
        ),
      /exception \[reportable, tenant:42\]/
    )
  })

  test('clearRecorded only clears the requested application', async ({ assert }) => {
    const { recorder, store } = createRecorder()
    await store.save([
      storedEntry('testing-entry', 'testing', 1n),
      storedEntry('other-entry', 'other', 2n),
    ])

    await clearRecorded(recorder, 'testing')

    assert.lengthOf(await findEntries(recorder, { application: 'testing' }), 0)
    const remaining = await findEntries(recorder, { application: 'other' })
    assert.deepEqual(
      remaining.map((entry) => entry.uuid),
      ['other-entry']
    )
  })
})
