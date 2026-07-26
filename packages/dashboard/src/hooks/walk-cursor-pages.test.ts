import assert from 'node:assert/strict'
import test from 'node:test'

import { walkCursorPages, type CursorPage } from './walk-cursor-pages.ts'

type Row = { uuid: string }

function rows(prefix: string, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ uuid: `${prefix}-${index}` }))
}

test('walks beyond the first 100 rows until a known UUID overlaps', async () => {
  const pages: Record<string, CursorPage<Row>> = {
    head: { data: rows('newest', 100), nextCursor: 'second' },
    second: {
      data: [...rows('older', 37), { uuid: 'known' }, ...rows('already-known', 12)],
      nextCursor: 'third',
    },
    third: { data: rows('must-not-load', 10), nextCursor: null },
  }
  const visited: string[] = []

  const result = await walkCursorPages(
    async (cursor) => {
      const key = cursor ?? 'head'
      visited.push(key)
      return pages[key]!
    },
    (row) => (row.uuid === 'known' ? 'overlap' : 'collect')
  )

  assert.deepEqual(visited, ['head', 'second'])
  assert.equal(result.length, 137)
  assert.equal(result.at(0)?.uuid, 'newest-0')
  assert.equal(result.at(-1)?.uuid, 'older-36')
})

test('walks to the backend end cursor when there is no overlap', async () => {
  const visited: Array<string | undefined> = []

  const result = await walkCursorPages(
    async (cursor) => {
      visited.push(cursor)
      if (cursor === undefined) return { data: rows('one', 2), nextCursor: 'two' }
      if (cursor === 'two') return { data: rows('two', 2), nextCursor: 'three' }
      return { data: rows('three', 1), nextCursor: null }
    },
    () => 'collect'
  )

  assert.deepEqual(visited, [undefined, 'two', 'three'])
  assert.equal(result.length, 5)
})

test('rejects a repeated cursor instead of silently looping or truncating', async () => {
  await assert.rejects(
    () =>
      walkCursorPages(
        async () => ({ data: [], nextCursor: 'same' }),
        () => 'collect'
      ),
    /repeated cursor/
  )
})
