import assert from 'node:assert/strict'
import test from 'node:test'

import { globalSearchFilters, globalSearchTarget, normalizeExactTag } from './global-search.ts'

test('normalizes whitespace while preserving exact tag spelling and punctuation', () => {
  assert.equal(normalizeExactTag('  Auth:42  '), 'Auth:42')
  assert.equal(normalizeExactTag('   '), undefined)
  assert.equal(normalizeExactTag(null), undefined)
})

test('always targets the global search screen instead of the current entry screen', () => {
  assert.equal(globalSearchTarget('Auth:42'), '/search?tag=Auth%3A42')
  assert.equal(globalSearchTarget(' status:500 '), '/search?tag=status%3A500')
  assert.equal(globalSearchTarget(''), '/search')
})

test('builds an exact-tag filter without constraining entry type', () => {
  assert.deepEqual(globalSearchFilters('Auth:42'), {
    tag: 'Auth:42',
    displayOnIndex: true,
    limit: 50,
  })
  assert.equal(globalSearchFilters(''), null)
})
