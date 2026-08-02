/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'

import {
  BATCH_EXPORT_FORMAT,
  BATCH_EXPORT_VERSION,
  parseBatchExport,
  serializeBatchExport,
} from '../../src/batch_export.ts'
import { PeriscopeError } from '../../src/errors.ts'
import { MemoryStore } from '../../src/storage/memory_store.ts'
import { EntryType } from '../../src/types.ts'
import { makeStoredEntry } from '../storage/contract.ts'

function exportObject(entries = [makeStoredEntry()]) {
  const json = serializeBatchExport(entries[0].batchId, entries)
  if (json === null) {
    throw new Error('Expected the fixture batch to serialize')
  }

  return JSON.parse(json) as Record<string, unknown>
}

test.group('batch export', () => {
  test('round-trips every stored entry field', ({ assert }) => {
    const batchId = 'batch-round-trip'
    const entries = [
      makeStoredEntry({
        uuid: 'entry-one',
        batchId,
        application: 'shop',
        type: EntryType.QUERY,
        familyHash: 'query-family',
        content: { sql: 'select 1', bindings: [1, 'two'] },
        tags: ['database', 'slow'],
        shouldDisplayOnIndex: false,
        sequence: 9_223_372_036_854_775_807n,
        createdAt: new Date('2026-01-02T03:04:05.678Z'),
      }),
      makeStoredEntry({
        uuid: 'entry-two',
        batchId,
        application: 'shop',
        type: EntryType.LOG,
        familyHash: null,
        content: {},
        tags: [],
        sequence: 9_223_372_036_854_775_808n,
        createdAt: new Date('2026-01-02T03:04:06.000Z'),
      }),
    ]

    const json = serializeBatchExport(batchId, entries)
    assert.isNotNull(json)
    assert.deepEqual(parseBatchExport(json!), {
      batchId,
      application: 'shop',
      entries,
    })
  })

  test('rejects an unknown format', ({ assert }) => {
    const value = exportObject()
    value.format = 'other.batch'

    assert.throws(
      () => parseBatchExport(JSON.stringify(value)),
      PeriscopeError,
      `expected "${BATCH_EXPORT_FORMAT}"`
    )
  })

  test('rejects a future version and names both versions', ({ assert }) => {
    const value = exportObject()
    value.version = 2

    assert.throws(
      () => parseBatchExport(JSON.stringify(value)),
      PeriscopeError,
      `Unsupported batch export version 2; supported version is ${BATCH_EXPORT_VERSION}`
    )
  })

  test('rejects an invalid entry date with its field path', ({ assert }) => {
    const value = exportObject()
    const entries = value.entries as Record<string, unknown>[]
    entries[0].createdAt = 'not-a-date'

    assert.throws(
      () => parseBatchExport(JSON.stringify(value)),
      PeriscopeError,
      'entries[0].createdAt is not an ISO date'
    )
  })

  test('rejects a non-array entries field', ({ assert }) => {
    const value = exportObject()
    value.entries = {}

    assert.throws(
      () => parseBatchExport(JSON.stringify(value)),
      PeriscopeError,
      'entries must be an array'
    )
  })

  test('rejects an entry missing its uuid', ({ assert }) => {
    const value = exportObject()
    const entries = value.entries as Record<string, unknown>[]
    delete entries[0].uuid

    assert.throws(
      () => parseBatchExport(JSON.stringify(value)),
      PeriscopeError,
      'entries[0].uuid must be a string'
    )
  })

  test('can save a parsed export and retrieve its batch', async ({ assert }) => {
    const batchId = 'batch-for-store'
    const entries = [
      makeStoredEntry({ batchId, uuid: 'stored-one', sequence: 10n }),
      makeStoredEntry({ batchId, uuid: 'stored-two', sequence: 20n }),
    ]
    const json = serializeBatchExport(batchId, entries)
    assert.isNotNull(json)

    const parsed = parseBatchExport(json!)
    const store = new MemoryStore()
    await store.save(parsed.entries)

    assert.deepEqual(await store.batch(batchId), entries)
  })
})
