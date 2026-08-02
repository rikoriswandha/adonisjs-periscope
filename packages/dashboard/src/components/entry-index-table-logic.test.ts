import assert from 'node:assert/strict'
import test from 'node:test'

import { reconcileLiveTailQueue } from './entry-index-table-logic.ts'

test('queues every pending row and pauses live tail away from the top', () => {
  assert.deepEqual(reconcileLiveTailQueue({ atTop: false, enabled: true, pendingCount: 3 }), {
    paused: true,
    queued: 3,
    shouldFlush: false,
  })
  assert.deepEqual(reconcileLiveTailQueue({ atTop: false, enabled: true, pendingCount: 7 }), {
    paused: true,
    queued: 7,
    shouldFlush: false,
  })
})

test('flushes queued rows on return to the top', () => {
  assert.deepEqual(reconcileLiveTailQueue({ atTop: true, enabled: true, pendingCount: 7 }), {
    paused: false,
    queued: 0,
    shouldFlush: true,
  })
})

test('leaves pending rows for the manual action when live tail is off', () => {
  assert.deepEqual(reconcileLiveTailQueue({ atTop: true, enabled: false, pendingCount: 7 }), {
    paused: false,
    queued: 0,
    shouldFlush: false,
  })
})
