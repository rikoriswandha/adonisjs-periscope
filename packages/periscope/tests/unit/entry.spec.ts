/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'

import { IncomingEntry } from '../../src/entry.ts'
import { PeriscopeError } from '../../src/errors.ts'
import { EntryType } from '../../src/types.ts'

/**
 * `randomUUID()` is specified to produce a version 4, variant 1 UUID. Watchers hand entry uuids
 * to the dashboard as route parameters and storage drivers use them as primary keys, so the
 * shape is part of the contract rather than an implementation detail.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test.group('IncomingEntry | make', () => {
  test('initialise every field a freshly observed entry starts with', ({ assert }) => {
    const content = { sql: 'select 1', duration: 3 }
    const before = Date.now()
    const entry = IncomingEntry.make(EntryType.QUERY, content)
    const after = Date.now()

    assert.match(entry.uuid, UUID_V4)
    assert.equal(entry.type, EntryType.QUERY)

    /**
     * The recorder swaps `content` for a redacted copy, so `make()` must hand the watcher's own
     * object through untouched rather than cloning it.
     */
    assert.strictEqual(entry.content, content)

    assert.instanceOf(entry.createdAt, Date)
    assert.isAtLeast(entry.createdAt.getTime(), before)
    assert.isAtMost(entry.createdAt.getTime(), after)

    assert.deepEqual(entry.tags, [])
    assert.isNull(entry.familyHash)
    assert.isTrue(entry.displayOnIndex)
    assert.isNull(entry.batchId)
    assert.isNull(entry.sequence)
  })

  test('default the content to an empty object', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.DUMP)

    assert.deepEqual(entry.content, {})
  })

  test('give every entry its own uuid', ({ assert }) => {
    const uuids = new Set(Array.from({ length: 50 }, () => IncomingEntry.make(EntryType.LOG).uuid))

    assert.equal(uuids.size, 50)
  })
})

test.group('IncomingEntry | withTags', () => {
  test('append tags and return the same instance', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.REQUEST)

    assert.strictEqual(entry.withTags('status:500'), entry)
    assert.deepEqual(entry.tags, ['status:500'])
  })

  test('accept several tags in one call and across calls, in insertion order', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.REQUEST)
      .withTags('status:500', 'auth:42')
      .withTags('slow')

    assert.deepEqual(entry.tags, ['status:500', 'auth:42', 'slow'])
  })

  test('de-duplicate repeated tags without disturbing the original order', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.REQUEST).withTags('a', 'b', 'a').withTags('b', 'c')

    assert.deepEqual(entry.tags, ['a', 'b', 'c'])
  })

  test('ignore undefined, null and empty tags so callers need not filter first', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.REQUEST).withTags(
      undefined,
      null,
      '',
      'kept',
      undefined
    )

    assert.deepEqual(entry.tags, ['kept'])
  })

  test('hand out a fresh array that cannot be used to mutate the entry', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.REQUEST).withTags('a')

    const first = entry.tags
    assert.notStrictEqual(first, entry.tags)

    first.push('smuggled')
    assert.deepEqual(entry.tags, ['a'])
  })
})

test.group('IncomingEntry | withFamilyHash', () => {
  test('set the grouping hash and return the same instance', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.QUERY)

    assert.strictEqual(entry.withFamilyHash('abc123'), entry)
    assert.equal(entry.familyHash, 'abc123')
  })

  test('clear the hash when given an empty string', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.QUERY).withFamilyHash('abc123')

    entry.withFamilyHash('')

    assert.isNull(entry.familyHash)
  })

  test('clear the hash when given null', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.QUERY).withFamilyHash('abc123')

    entry.withFamilyHash(null)

    assert.isNull(entry.familyHash)
  })
})

test.group('IncomingEntry | hiddenFromIndex', () => {
  test('hide the entry from index screens and return the same instance', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.QUERY)

    assert.strictEqual(entry.hiddenFromIndex(), entry)
    assert.isFalse(entry.displayOnIndex)
  })

  test('stay hidden when called again', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.QUERY).hiddenFromIndex().hiddenFromIndex()

    assert.isFalse(entry.displayOnIndex)
  })
})

test.group('IncomingEntry | stamp', () => {
  test('bind the batch id and sequence and return the same instance', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.LOG)

    assert.strictEqual(entry.stamp('batch-1', 42n), entry)
    assert.equal(entry.batchId, 'batch-1')
    assert.equal(entry.sequence, 42n)
  })
})

test.group('IncomingEntry | toStored', () => {
  test('produce the exact shape storage drivers persist', ({ assert }) => {
    const content = { message: 'hello', level: 'info' }
    const entry = IncomingEntry.make(EntryType.LOG, content)
      .withTags('level:info', 'channel:app')
      .withFamilyHash('family-1')
      .stamp('batch-1', 7n)

    const stored = entry.toStored()

    assert.deepEqual(Object.keys(stored).sort(), [
      'batchId',
      'content',
      'createdAt',
      'familyHash',
      'sequence',
      'shouldDisplayOnIndex',
      'tags',
      'type',
      'uuid',
    ])

    assert.deepEqual(stored, {
      uuid: entry.uuid,
      batchId: 'batch-1',
      type: EntryType.LOG,
      familyHash: 'family-1',
      content,
      tags: ['level:info', 'channel:app'],
      shouldDisplayOnIndex: true,
      sequence: 7n,
      createdAt: entry.createdAt,
    })

    assert.strictEqual(stored.content, content)
    assert.strictEqual(stored.createdAt, entry.createdAt)
  })

  test('mirror displayOnIndex onto the renamed shouldDisplayOnIndex field', ({ assert }) => {
    const visible = IncomingEntry.make(EntryType.QUERY).stamp('batch-1', 1n).toStored()
    const hidden = IncomingEntry.make(EntryType.QUERY)
      .hiddenFromIndex()
      .stamp('batch-1', 2n)
      .toStored()

    assert.isTrue(visible.shouldDisplayOnIndex)
    assert.isFalse(hidden.shouldDisplayOnIndex)
  })

  test('snapshot the tags into a detached plain array', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.LOG).withTags('a').stamp('batch-1', 1n)
    const stored = entry.toStored()

    assert.isArray(stored.tags)
    assert.notStrictEqual(stored.tags, entry.tags)

    stored.tags.push('smuggled')
    entry.withTags('later')

    assert.deepEqual(stored.tags, ['a', 'smuggled'])
    assert.deepEqual(entry.tags, ['a', 'later'])
  })

  test('reject an entry that never reached the recorder', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.EXCEPTION)

    /**
     * An unstamped entry means one escaped the recorder, so the message has to identify the
     * offending entry precisely enough to find the watcher that leaked it.
     */
    assert.throws(() => entry.toStored(), PeriscopeError, entry.uuid)
    assert.throws(() => entry.toStored(), PeriscopeError, `(${EntryType.EXCEPTION})`)
  })

  test('reject an entry carrying a batch id but no sequence', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.EXCEPTION).stamp('batch-1', 1n)
    entry.sequence = null

    assert.throws(() => entry.toStored(), PeriscopeError, entry.uuid)
  })

  test('reject an entry carrying a sequence but no batch id', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.EXCEPTION).stamp('batch-1', 1n)
    entry.batchId = null

    assert.throws(() => entry.toStored(), PeriscopeError)
  })
})

test.group('IncomingEntry | fluent chaining', () => {
  test('compose every builder call on one instance', ({ assert }) => {
    const entry = IncomingEntry.make(EntryType.QUERY, { sql: 'select 1' })
    const chained = entry.withTags('slow').withFamilyHash('family-1').hiddenFromIndex()

    assert.strictEqual(chained, entry)
    assert.deepEqual(entry.tags, ['slow'])
    assert.equal(entry.familyHash, 'family-1')
    assert.isFalse(entry.displayOnIndex)
  })
})
