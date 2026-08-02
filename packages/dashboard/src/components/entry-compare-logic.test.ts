import assert from 'node:assert/strict'
import test from 'node:test'

import { diffEntryContent } from './entry-compare-logic.ts'

test('classifies matching, changed, and one-sided content keys', () => {
  const result = diffEntryContent(
    { changed: { count: 1 }, leftOnly: true, same: ['a', 2] },
    { changed: { count: 2 }, rightOnly: false, same: ['a', 2] }
  )

  assert.deepEqual(
    result.map(({ key, status }) => ({ key, status })),
    [
      { key: 'changed', status: 'changed' },
      { key: 'leftOnly', status: 'left-only' },
      { key: 'rightOnly', status: 'right-only' },
      { key: 'same', status: 'same' },
    ]
  )
})

test('treats nested objects with different key order as equal JSON values', () => {
  const [row] = diffEntryContent(
    { payload: { first: 1, nested: { a: true, b: false } } },
    { payload: { nested: { b: false, a: true }, first: 1 } }
  )

  assert.equal(row.status, 'same')
})
