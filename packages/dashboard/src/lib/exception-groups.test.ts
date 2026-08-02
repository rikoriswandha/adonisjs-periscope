import assert from 'node:assert/strict'
import test from 'node:test'

import { isNewExceptionGroup, mergeExceptionGroups } from './exception-groups.ts'
import { bucketExceptionOccurrences } from './exception-trend.ts'
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
    state: 'open',
    stateUpdatedAt: null,
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

test('buckets real occurrence timestamps across the last 24 hours', () => {
  const now = new Date('2026-07-27T00:00:00.000Z').getTime()
  const entries = [
    { createdAt: '2026-07-25T23:59:59.999Z' },
    { createdAt: '2026-07-26T00:00:00.000Z' },
    { createdAt: '2026-07-26T05:59:59.999Z' },
    { createdAt: '2026-07-26T06:00:00.000Z' },
    { createdAt: '2026-07-26T18:00:00.000Z' },
    { createdAt: '2026-07-27T00:00:00.000Z' },
    { createdAt: '2026-07-27T00:00:00.001Z' },
    { createdAt: 'not-a-date' },
  ]

  assert.deepEqual(bucketExceptionOccurrences(entries, now, 4), [2, 1, 0, 2])
  assert.deepEqual(bucketExceptionOccurrences(entries, now, 0), [])
})
