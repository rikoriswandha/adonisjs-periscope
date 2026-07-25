/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { Readable } from 'node:stream'

import { test } from '@japa/runner'

import { SERIALIZER_DEFAULTS, safeSerialize } from '../../../src/recorder/serializer.ts'

test.group('Serializer', () => {
  test('pass primitives through untouched', ({ assert }) => {
    assert.strictEqual(safeSerialize('hello'), 'hello')
    assert.strictEqual(safeSerialize(42), 42)
    assert.strictEqual(safeSerialize(-1.5), -1.5)
    assert.strictEqual(safeSerialize(true), true)
    assert.strictEqual(safeSerialize(false), false)
    assert.isNull(safeSerialize(null))
  })

  test('render non-finite numbers as their string form', ({ assert }) => {
    /**
     * `JSON.stringify` renders all three as `null`, which hides the numeric bug being chased.
     */
    assert.equal(safeSerialize(Number.NaN), 'NaN')
    assert.equal(safeSerialize(Number.POSITIVE_INFINITY), 'Infinity')
    assert.equal(safeSerialize(Number.NEGATIVE_INFINITY), '-Infinity')
    assert.deepEqual(safeSerialize({ ratio: Number.NaN }), { ratio: 'NaN' })
  })

  test('keep a present-but-undefined value visible', ({ assert }) => {
    assert.equal(safeSerialize(undefined), '[undefined]')
    assert.deepEqual(safeSerialize({ user: undefined }), { user: '[undefined]' })
  })

  test('tag bigints, symbols and functions', ({ assert }) => {
    class Widget {}

    assert.equal(safeSerialize(123n), '123n')
    assert.equal(safeSerialize(Symbol('cache-key')), 'Symbol(cache-key)')
    assert.equal(
      safeSerialize(function run() {}),
      '[Function: run]'
    )
    assert.equal(
      safeSerialize(() => {}),
      '[Function: anonymous]'
    )
    assert.equal(safeSerialize(Widget), '[Function: Widget]')
  })

  test('render dates, regexps and urls', ({ assert }) => {
    assert.equal(safeSerialize(new Date('2024-03-01T10:20:30.000Z')), '2024-03-01T10:20:30.000Z')
    assert.equal(safeSerialize(/ab+c/gi), '/ab+c/gi')
    assert.equal(
      safeSerialize(new URL('https://adonisjs.com/docs?q=1')),
      'https://adonisjs.com/docs?q=1'
    )
  })

  test('render an error as its name, message and stack', ({ assert }) => {
    const result = safeSerialize(new TypeError('bad argument')) as Record<string, unknown>

    assert.equal(result.name, 'TypeError')
    assert.equal(result.message, 'bad argument')

    const stack = result.stack
    assert.isString(stack)
    assert.include(String(stack), 'bad argument')
  })

  test('render maps and sets with their size and contents', ({ assert }) => {
    assert.deepEqual(
      safeSerialize(
        new Map([
          ['a', 1],
          ['b', 2],
        ])
      ),
      {
        __type: 'Map',
        size: 2,
        entries: [
          ['a', 1],
          ['b', 2],
        ],
      }
    )

    assert.deepEqual(safeSerialize(new Set(['x', 'y'])), {
      __type: 'Set',
      size: 2,
      values: ['x', 'y'],
    })
  })

  test('recurse through map keys and set values', ({ assert }) => {
    const map = new Map<unknown, unknown>([[{ id: 1 }, new Set([undefined])]])

    assert.deepEqual(safeSerialize(map), {
      __type: 'Map',
      size: 1,
      entries: [[{ id: 1 }, { __type: 'Set', size: 1, values: ['[undefined]'] }]],
    })
  })

  test('elide binary payloads instead of transcribing them', ({ assert }) => {
    assert.equal(safeSerialize(Buffer.alloc(1234)), '[Buffer 1234 bytes]')
    assert.equal(safeSerialize(new Uint8Array(12)), '[Uint8Array 12 bytes]')
    assert.equal(safeSerialize(new Float64Array(4)), '[Float64Array 32 bytes]')
    assert.equal(safeSerialize(new ArrayBuffer(8)), '[ArrayBuffer 8 bytes]')
    assert.equal(safeSerialize(new DataView(new ArrayBuffer(16))), '[DataView 16 bytes]')
  })

  test('elide a stream without consuming it', async ({ assert }) => {
    const readable = Readable.from(['chunk-a', 'chunk-b'])

    assert.equal(safeSerialize(readable), '[Stream Readable]')

    const chunks: string[] = []
    for await (const chunk of readable) {
      chunks.push(String(chunk))
    }

    assert.deepEqual(chunks, ['chunk-a', 'chunk-b'])
  })

  test('elide anything shaped like a stream', ({ assert }) => {
    class Uploaded {
      pipe(): void {}
      on(): void {}
    }

    assert.equal(safeSerialize(new Uploaded()), '[Stream Uploaded]')
    assert.equal(safeSerialize({ pipe() {}, on() {} }), '[Stream Object]')
  })

  test('prefer toJSON over walking the instance', ({ assert }) => {
    class Money {
      cents = 1999
      currency = 'EUR'

      toJSON() {
        return { amount: this.cents / 100, currency: this.currency }
      }
    }

    assert.deepEqual(safeSerialize(new Money()), { amount: 19.99, currency: 'EUR' })
  })

  test('handle dates before toJSON so an invalid date stays visible', ({ assert }) => {
    /**
     * `Date.prototype.toJSON` answers `null` for an invalid date, losing the fact that a date
     * was there at all. The dedicated branch must therefore win over the `toJSON` preference.
     */
    assert.equal(safeSerialize(new Date('not a date')), 'Invalid Date')
    assert.equal(safeSerialize(new Date(0)), '1970-01-01T00:00:00.000Z')
  })

  test('report a throwing toJSON instead of propagating it', ({ assert }) => {
    const value = {
      toJSON() {
        throw new Error('cannot serialise me')
      },
    }

    assert.equal(safeSerialize(value), '[toJSON threw: cannot serialise me]')
  })

  test('replace a circular reference with a marker', ({ assert }) => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node
    node.children = [node]

    assert.deepEqual(safeSerialize(node), {
      name: 'root',
      self: '[Circular]',
      children: ['[Circular]'],
    })
  })

  test('serialise a repeated sibling twice instead of calling it circular', ({ assert }) => {
    const shared = { id: 7 }

    assert.deepEqual(safeSerialize({ left: shared, right: shared, list: [shared, shared] }), {
      left: { id: 7 },
      right: { id: 7 },
      list: [{ id: 7 }, { id: 7 }],
    })
  })

  test('stop at the configured depth', ({ assert }) => {
    assert.deepEqual(safeSerialize({ a: { b: { c: { d: 'deep' } } } }, { maxDepth: 2 }), {
      a: { b: { c: '[Depth limit]' } },
    })
  })

  test('keep leaves that sit past the deepest walked container', ({ assert }) => {
    assert.deepEqual(safeSerialize({ a: { b: { c: 'leaf' } } }, { maxDepth: 2 }), {
      a: { b: { c: 'leaf' } },
    })
  })

  test('default to four levels of nesting', ({ assert }) => {
    assert.equal(SERIALIZER_DEFAULTS.maxDepth, 4)

    assert.deepEqual(safeSerialize({ l1: { l2: { l3: { l4: { l5: { l6: true } } } } } }), {
      l1: { l2: { l3: { l4: { l5: '[Depth limit]' } } } },
    })
  })

  test('stay within the byte budget on a large input', ({ assert }) => {
    const payload = Array.from({ length: 10_000 }, (_, index) => `${index}:${'x'.repeat(500)}`)

    const result = safeSerialize(payload)

    assert.isBelow(Buffer.byteLength(JSON.stringify(result)), SERIALIZER_DEFAULTS.maxBytes * 2)

    const items = result as unknown[]
    assert.isBelow(items.length, 100)
    assert.equal(items[0], payload[0])
    assert.equal(items[items.length - 1], '[Truncated]')
  })

  test('charge a container for its own scaffolding, not just its children', ({ assert }) => {
    /**
     * Containers used to charge the budget for their children only, so a value built entirely
     * out of *empty* containers cost nothing at all while still rendering megabytes: against the
     * 16 KB default these three inputs produced 311 KB (19x), 320 KB (19.5x) and 483 KB (29.5x).
     *
     * The bound asserted here is three times `maxBytes`. Exact adherence is impossible by
     * construction: a node is charged before its children are known, so the last node the budget
     * admits may still emit a whole subtree's worth of scaffolding afterwards. Three is the same
     * slack the hostile-gauntlet test allows, and it still leaves an order of magnitude between
     * a pass and the defect this guards against.
     */
    const limit = SERIALIZER_DEFAULTS.maxBytes * 3

    const emptySets = Array.from({ length: 50_000 }, () => new Set<string>())
    const emptyMaps = Array.from({ length: 200_000 }, () => new Map<string, string>())
    const nestedMaps = Array.from(
      { length: 200_000 },
      () => new Map<Map<string, string>, Map<string, string>>([[new Map(), new Map()]])
    )

    assert.isBelow(Buffer.byteLength(JSON.stringify(safeSerialize(emptySets))), limit)
    assert.isBelow(Buffer.byteLength(JSON.stringify(safeSerialize(emptyMaps))), limit)
    assert.isBelow(Buffer.byteLength(JSON.stringify(safeSerialize(nestedMaps))), limit)

    /**
     * The bound must be the budget doing the work, not some accident of the input: the run of
     * containers has to end in the ordinary overflow marker.
     */
    const truncated = safeSerialize(emptySets) as unknown[]
    assert.isBelow(truncated.length, 50_000)
    assert.equal(truncated[truncated.length - 1], '[Truncated]')
  })

  test('serialise a modest nested value in full despite the container charge', ({ assert }) => {
    /**
     * Charging containers may only bite runaways. This is an ordinary response payload sitting
     * far inside the default budget, so not one node of it is allowed to be elided.
     */
    const input = {
      user: { id: 42, email: 'ada@example.com', roles: ['admin', 'editor'] },
      meta: { page: 1, total: 3, tags: new Set(['billing', 'urgent']) },
      items: [
        { sku: 'A-1', qty: 2 },
        { sku: 'B-2', qty: 5 },
      ],
    }

    assert.deepEqual(safeSerialize(input), {
      user: { id: 42, email: 'ada@example.com', roles: ['admin', 'editor'] },
      meta: {
        page: 1,
        total: 3,
        tags: { __type: 'Set', size: 2, values: ['billing', 'urgent'] },
      },
      items: [
        { sku: 'A-1', qty: 2 },
        { sku: 'B-2', qty: 5 },
      ],
    })
  })

  test('mark the tail of a truncated array', ({ assert }) => {
    const result = safeSerialize([1, 2, 3, 4, 5], { maxBytes: 20 }) as unknown[]

    assert.equal(result[0], 1)
    assert.isBelow(result.length, 5)
    assert.equal(result[result.length - 1], '[Truncated]')
  })

  test('mark a truncated object with a truncated key', ({ assert }) => {
    const result = safeSerialize({ a: 1, b: 2, c: 3, d: 4 }, { maxBytes: 20 }) as Record<
      string,
      unknown
    >

    assert.equal(result.a, 1)
    assert.isBelow(Object.keys(result).length, 4)
    assert.property(result, '[Truncated]')
  })

  test('truncate a single oversized string', ({ assert }) => {
    const text = String(safeSerialize('y'.repeat(50_000), { maxBytes: 64 }))

    assert.isTrue(text.endsWith('[Truncated]'))
    assert.isBelow(Buffer.byteLength(text), 128)
  })

  test('report a throwing accessor per property', ({ assert }) => {
    const input = {
      ok: 1,
      get relation(): string {
        throw new Error('relation not loaded')
      },
    }

    assert.deepEqual(safeSerialize(input), {
      ok: 1,
      relation: '[Getter threw: relation not loaded]',
    })
  })

  test('walk only own enumerable properties and name the class', ({ assert }) => {
    class Widget {
      id = 3

      get computed(): number {
        return 9
      }

      render(): string {
        return 'x'
      }
    }

    assert.deepEqual(safeSerialize(new Widget()), { __class: 'Widget', id: 3 })
  })

  test('skip non-enumerable own properties', ({ assert }) => {
    const input = { visible: 1 }
    Object.defineProperty(input, 'hidden', { value: 2, enumerable: false })

    assert.deepEqual(safeSerialize(input), { visible: 1 })
  })

  test('omit the class marker for plain and null-prototype objects', ({ assert }) => {
    assert.deepEqual(safeSerialize({ a: 1 }), { a: 1 })

    const bag: Record<string, unknown> = Object.create(null)
    bag.a = 1

    assert.deepEqual(safeSerialize(bag), { a: 1 })
  })

  test('skip symbol-keyed properties', ({ assert }) => {
    assert.deepEqual(safeSerialize({ visible: 1, [Symbol('hidden')]: 2 }), { visible: 1 })
  })

  test('keep an own __proto__ key as data instead of retargeting the prototype', ({ assert }) => {
    const input: unknown = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}')
    const result = safeSerialize(input) as Record<string, unknown>

    assert.strictEqual(Object.getPrototypeOf(result), Object.prototype)
    assert.deepEqual(Object.getOwnPropertyDescriptor(result, '__proto__')?.value, {
      polluted: true,
    })
    assert.equal(result.safe, 1)
    assert.doesNotThrow(() => JSON.stringify(result))
  })

  test('degrade a hostile proxy to a marker instead of throwing', ({ assert }) => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('get trap')
        },
        ownKeys() {
          throw new Error('ownKeys trap')
        },
      }
    )

    const result = safeSerialize({ hostile, ok: 1 }) as Record<string, unknown>

    assert.equal(result.hostile, '[Unserializable]')
    assert.equal(result.ok, 1)
  })

  test('never mutate the input value', ({ assert }) => {
    const input = {
      list: [1, 2, 3],
      nested: { when: new Date('2024-01-01T00:00:00.000Z'), flag: false },
    }
    const snapshot = structuredClone(input)

    safeSerialize(input)

    assert.deepEqual(input, snapshot)
    assert.lengthOf(Object.keys(input), 2)
  })

  test('survive a gauntlet of hostile values', ({ assert }) => {
    const circular: Record<string, unknown> = { name: 'root' }
    circular.self = circular

    const hostileProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('get trap')
        },
        ownKeys() {
          throw new Error('ownKeys trap')
        },
        getOwnPropertyDescriptor() {
          throw new Error('descriptor trap')
        },
      }
    )

    /**
     * `huge` sits last on purpose: it eats whatever budget is left, so every hostile member
     * before it is genuinely walked rather than collapsed into a truncation marker.
     */
    const gauntlet = {
      circular,
      big: 2n ** 64n,
      [Symbol('symbol-key')]: 'skipped',
      symbolValue: Symbol('value'),
      fn: function named() {},
      map: new Map<unknown, unknown>([[{ key: true }, new Set([1, 2])]]),
      binary: Buffer.alloc(64),
      stream: new Readable({ read() {} }),
      bag: Object.create(null) as Record<string, unknown>,
      invalidDate: new Date('nope'),
      thrower: {
        toJSON() {
          throw new Error('nope')
        },
      },
      proxy: hostileProxy,
      get boom(): string {
        throw new Error('getter exploded')
      },
      huge: 'z'.repeat(10 * 1024 * 1024),
    }

    const result = safeSerialize(gauntlet) as Record<string, unknown>

    assert.doesNotThrow(() => JSON.stringify(result))
    assert.isBelow(Buffer.byteLength(JSON.stringify(result)), SERIALIZER_DEFAULTS.maxBytes * 3)

    const circularResult = result.circular as Record<string, unknown>
    assert.equal(circularResult.name, 'root')
    assert.equal(circularResult.self, '[Circular]')
    assert.equal(result.big, '18446744073709551616n')
    assert.equal(result.symbolValue, 'Symbol(value)')
    assert.equal(result.fn, '[Function: named]')
    assert.equal(result.binary, '[Buffer 64 bytes]')
    assert.equal(result.stream, '[Stream Readable]')
    assert.equal(result.invalidDate, 'Invalid Date')
    assert.equal(result.thrower, '[toJSON threw: nope]')
    assert.equal(result.proxy, '[Unserializable]')
    assert.equal(result.boom, '[Getter threw: getter exploded]')
    assert.isTrue(String(result.huge).endsWith('[Truncated]'))
    assert.notProperty(result, 'symbol-key')
  })
})
