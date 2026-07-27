import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeMonitoredTags, setMonitoredTag } from './monitored-tags.ts'

test('monitored tags from another window are normalized before replacing local state', () => {
  assert.deepEqual(normalizeMonitoredTags(['Team:2', 'Team:1']), ['Team:1', 'Team:2'])
})

test('optimistic tag updates preserve unrelated local mutations when one request is reverted', () => {
  const initial = ['Team:1']
  const withFirstMutation = setMonitoredTag(initial, 'Team:2', true)
  const withConcurrentMutation = setMonitoredTag(withFirstMutation, 'Team:3', true)
  const afterFirstMutationRollback = setMonitoredTag(withConcurrentMutation, 'Team:2', false)

  assert.deepEqual(afterFirstMutationRollback, ['Team:1', 'Team:3'])
  assert.strictEqual(
    setMonitoredTag(afterFirstMutationRollback, 'Team:3', true),
    afterFirstMutationRollback
  )
})
