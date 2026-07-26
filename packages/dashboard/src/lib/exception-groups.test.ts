import assert from 'node:assert/strict'
import test from 'node:test'

import { isNewExceptionGroup, mergeExceptionGroups } from './exception-groups.ts'
import type { ExceptionGroup } from '../types.ts'

function group(
  familyHash: string,
  uuid: string,
  count: number,
  lastSeen = '2026-07-26T00:00:00.000Z'
): ExceptionGroup {
  return {
    familyHash,
    count,
    lastSeen,
    latest: { uuid } as ExceptionGroup['latest'],
  }
}

test('recognizes only new families or non-decreasing families with a new latest UUID', () => {
  const previous = group('family', 'old', 8)

  assert.equal(isNewExceptionGroup(undefined, group('new-family', 'new', 1)), true)
  assert.equal(isNewExceptionGroup(previous, group('family', 'old', 9)), false)
  assert.equal(isNewExceptionGroup(previous, group('family', 'new', 8)), true)
  assert.equal(isNewExceptionGroup(previous, group('family', 'new', 9)), true)
})

test('does not present a count decrease as a new exception', () => {
  const previous = group('family', 'old', 8)

  assert.equal(isNewExceptionGroup(previous, group('family', 'new', 7)), false)
})

test('merges families by hash and preserves newest-first ordering', () => {
  const merged = mergeExceptionGroups(
    [group('older', 'old-uuid', 1, '2026-07-25T00:00:00.000Z')],
    [
      group('newer', 'new-uuid', 1, '2026-07-27T00:00:00.000Z'),
      group('older', 'replacement', 2, '2026-07-26T00:00:00.000Z'),
    ]
  )

  assert.deepEqual(
    merged.map((item) => [item.familyHash, item.latest.uuid, item.count]),
    [
      ['newer', 'new-uuid', 1],
      ['older', 'replacement', 2],
    ]
  )
})
