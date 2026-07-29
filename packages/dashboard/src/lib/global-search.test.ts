import assert from 'node:assert/strict'
import test from 'node:test'

import {
  globalSearchFilters,
  globalSearchTarget,
  normalizeExactTag,
  presetTimeRange,
} from './global-search.ts'

test('normalizes whitespace while preserving exact tag spelling and punctuation', () => {
  assert.equal(normalizeExactTag('  Auth:42  '), 'Auth:42')
  assert.equal(normalizeExactTag('   '), undefined)
  assert.equal(normalizeExactTag(null), undefined)
})

test('targets the global search screen with a free-text query', () => {
  assert.equal(globalSearchTarget('checkout failed'), '/search?text=checkout%20failed')
  assert.equal(globalSearchTarget('  status 500  '), '/search?text=status%20500')
  assert.equal(globalSearchTarget(''), '/search')
})

test('builds global filters from repeated tags, type, text, and an inclusive time range', () => {
  const params = new URLSearchParams()
  params.set('text', '  checkout  ')
  params.append('tag', 'slow')
  params.append('tag', 'tenant:acme')
  params.append('tag', 'slow')
  params.set('type', 'request')
  params.set('from', '2026-07-29T10:00:00.000Z')
  params.set('to', '2026-07-29T11:00:00.000Z')

  assert.deepEqual(globalSearchFilters(params), {
    text: 'checkout',
    tags: ['slow', 'tenant:acme'],
    type: 'request',
    from: '2026-07-29T10:00:00.000Z',
    to: '2026-07-29T11:00:00.000Z',
    displayOnIndex: true,
    limit: 50,
  })
  assert.equal(globalSearchFilters(new URLSearchParams()), null)
})

test('creates stable ISO boundaries for quick time presets', () => {
  assert.deepEqual(presetTimeRange(15, new Date('2026-07-29T11:00:00.000Z')), {
    from: '2026-07-29T10:45:00.000Z',
    to: '2026-07-29T11:00:00.000Z',
  })
})
