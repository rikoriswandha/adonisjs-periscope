import assert from 'node:assert/strict'
import test from 'node:test'

import { detectNPlusOneWarnings } from './n-plus-one.ts'
import type { StoredEntry } from '../types.ts'

function query(uuid: string, familyHash: string | null, sql = 'select * from users'): StoredEntry {
  return {
    uuid,
    batchId: 'batch-1',
    application: 'shop',
    type: 'query',
    familyHash,
    content: { sql },
    tags: [],
    shouldDisplayOnIndex: true,
    sequence: uuid,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

test('surfaces repeated query families at the configured boundary', () => {
  const entries = [
    query('1', 'users'),
    query('2', 'posts', 'select * from posts'),
    query('3', 'users'),
    query('4', 'users'),
    query('5', null),
  ]

  assert.deepEqual(detectNPlusOneWarnings(entries, 3), [
    { familyHash: 'users', count: 3, sql: 'select * from users' },
  ])
})

test('sorts the most repeated family first and ignores non-query entries', () => {
  const request = { ...query('0', 'users'), type: 'request' as const }
  const entries = [
    request,
    query('1', 'users'),
    query('2', 'users'),
    query('3', 'posts'),
    query('4', 'posts'),
    query('5', 'posts'),
  ]

  assert.deepEqual(
    detectNPlusOneWarnings(entries, 2).map((warning) => warning.familyHash),
    ['posts', 'users']
  )
})
