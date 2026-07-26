/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'

import { TAG_INDEX_MAX_LENGTH, encodeJson, toTagRows } from '../../../src/storage/sql.ts'
import { makeStoredEntry } from '../../storage/contract.ts'

/**
 * These two functions sit under everything the SQL drivers do — every entry written by either
 * driver passes through both — and the contract suite can only observe them through a live
 * database, where a dropped tag row and a dropped batch look alike. So they are pinned here,
 * directly, against the two inputs that made them worth writing: a duplicate or over-long tag,
 * and a value `JSON.stringify` refuses.
 */
test.group('sql | toTagRows', () => {
  test('emit one row per distinct tag', ({ assert }) => {
    const entry = makeStoredEntry({ tags: ['auth', 'slow', 'auth', 'slow', 'auth'] })

    const rows = toTagRows(entry)

    /**
     * `(entry_uuid, tag)` is the primary key, so a repeated tag is not merely wasteful — it is a
     * unique-violation that fails the entry's own insert, and with it the batch around it.
     */
    assert.deepEqual(rows, [
      { entry_uuid: entry.uuid, tag: 'auth' },
      { entry_uuid: entry.uuid, tag: 'slow' },
    ])
  })

  test('skip a tag too long for the index column', ({ assert }) => {
    const long = 'x'.repeat(TAG_INDEX_MAX_LENGTH + 1)
    const entry = makeStoredEntry({ tags: ['auth', long, 'slow'] })

    const rows = toTagRows(entry)

    /**
     * A `config.hooks.tag` hook can return anything — a URL, a serialised id — and postgres
     * rejects an over-length `varchar` outright, taking the whole batch with it. Skipping the
     * index row is the only outcome that keeps the surrounding entries recorded.
     */
    assert.deepEqual(rows, [
      { entry_uuid: entry.uuid, tag: 'auth' },
      { entry_uuid: entry.uuid, tag: 'slow' },
    ])
  })

  test('index a tag of exactly the maximum length', ({ assert }) => {
    const exact = 'x'.repeat(TAG_INDEX_MAX_LENGTH)
    const entry = makeStoredEntry({ tags: [exact] })

    /**
     * The boundary is inclusive: 191 characters is what the column holds, so the off-by-one that
     * would quietly stop indexing every tag of the maximum width has to fail here.
     */
    assert.deepEqual(toTagRows(entry), [{ entry_uuid: entry.uuid, tag: exact }])
  })

  test('leave the entry tags themselves untouched', ({ assert }) => {
    const long = 'x'.repeat(TAG_INDEX_MAX_LENGTH + 1)
    const entry = makeStoredEntry({ tags: ['auth', long] })

    toTagRows(entry)

    /**
     * The `tags` JSON column is the authoritative, ordered copy the dashboard renders. Only the
     * filter index drops the long tag; the entry must still carry it in full.
     */
    assert.deepEqual(entry.tags, ['auth', long])
  })
})

test.group('sql | encodeJson', () => {
  test('encode an ordinary value as JSON text', ({ assert }) => {
    assert.equal(encodeJson({ method: 'GET', status: 200 }), '{"method":"GET","status":200}')
  })

  test('encode undefined as null rather than the undefined literal', ({ assert }) => {
    /**
     * `JSON.stringify(undefined)` returns `undefined`, not a string, and binding that to a `not
     * null` text column is a driver-level error. `null` is the one value every dialect accepts
     * and `decodeJson` round-trips.
     */
    assert.equal(encodeJson(undefined), 'null')
  })

  test('fall back to the safe serializer for a circular object', ({ assert }) => {
    const content: Record<string, unknown> = { url: '/orders' }
    content.self = content

    const encoded = encodeJson(content)

    /**
     * Watchers own their content shape and `JSON.stringify` throws on a cycle. Losing the batch
     * over it would lose the entries around the offending one too, so the cycle is replaced and
     * the rest of the payload survives.
     */
    assert.deepEqual(JSON.parse(encoded), { url: '/orders', self: '[Circular]' })
  })

  test('fall back to the safe serializer for a bigint', ({ assert }) => {
    const encoded = encodeJson({ rows: 12n })

    /**
     * `JSON.stringify` throws a `TypeError` on a `BigInt` — and a sequence, a row count or a
     * database id can easily be one. It has to reach storage as something readable rather than
     * cost the entry its content, so the serializer renders it with the `n` suffix it was
     * written with.
     */
    assert.deepEqual(JSON.parse(encoded), { rows: '12n' })
  })
})
