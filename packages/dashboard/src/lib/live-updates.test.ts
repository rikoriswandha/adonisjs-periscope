import assert from 'node:assert/strict'
import test from 'node:test'

import {
  liveUpdateLabel,
  parseFlushStreamEvent,
  shouldPollForUpdates,
  streamEventMatchesFilters,
} from './live-updates.ts'

const validEvent = {
  type: 'query',
  uuid: 'entry-1',
  indexRow: {
    uuid: 'entry-1',
    batchId: 'batch-1',
    type: 'query',
    familyHash: 'family-1',
    tags: ['Auth:42', 'slow'],
    shouldDisplayOnIndex: true,
    sequence: '12',
    createdAt: '2026-07-27T12:00:00.000Z',
  },
}

test('accepts a flush event carrying the complete index-row contract', () => {
  assert.deepEqual(parseFlushStreamEvent(JSON.stringify(validEvent)), validEvent)
})

test('rejects malformed, mismatched, and non-index flush events without throwing', () => {
  assert.equal(parseFlushStreamEvent('{not json'), null)
  assert.equal(
    parseFlushStreamEvent(JSON.stringify({ ...validEvent, uuid: 'different-entry' })),
    null
  )
  assert.equal(
    parseFlushStreamEvent(
      JSON.stringify({
        ...validEvent,
        indexRow: { ...validEvent.indexRow, shouldDisplayOnIndex: false },
      })
    ),
    null
  )
})

test('matches streamed rows against the active exact filters before refreshing', () => {
  const parsed = parseFlushStreamEvent(JSON.stringify(validEvent))
  assert.ok(parsed)
  assert.equal(
    streamEventMatchesFilters(parsed, { type: 'query', tag: 'Auth:42', displayOnIndex: true }),
    true
  )
  assert.equal(streamEventMatchesFilters(parsed, { type: 'query', tag: 'auth:42' }), false)
  assert.equal(streamEventMatchesFilters(parsed, { type: 'request', tag: 'Auth:42' }), false)
})

test('polls while connecting or degraded, but never beside a healthy live stream', () => {
  assert.equal(shouldPollForUpdates('connecting', false), true)
  assert.equal(shouldPollForUpdates('polling', false), true)
  assert.equal(shouldPollForUpdates('live', false), false)
  assert.equal(shouldPollForUpdates('polling', true), false)
})

test('exposes distinct accessible labels for live and polling fallback modes', () => {
  assert.equal(liveUpdateLabel('live', true), 'Live updates')
  assert.equal(liveUpdateLabel('polling', true), 'Polling fallback')
  assert.equal(liveUpdateLabel('connecting', true), 'Connecting live')
  assert.equal(liveUpdateLabel('off', true), 'Updates paused')
  assert.equal(liveUpdateLabel('off', false), 'Recording offline')
})
