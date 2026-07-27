/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'
import fc from 'fast-check'

import {
  DEFAULT_REDACT_HEADERS,
  DEFAULT_REDACT_KEYS,
  Redactor,
} from '../../../src/recorder/redactor.ts'
import type { ResolvedPeriscopeConfig } from '../../../src/types.ts'

/**
 * Build a redactor on the resolved defaults, overriding only what a test cares about. The
 * defaults are duplicated here on purpose rather than imported from `defineConfig`: these tests
 * pin the redactor's behaviour, not the config resolver's.
 */
function redactor(overrides: Partial<ResolvedPeriscopeConfig['redact']> = {}): Redactor {
  return new Redactor({
    keys: [...DEFAULT_REDACT_KEYS],
    headers: [...DEFAULT_REDACT_HEADERS],
    replacement: '[REDACTED]',
    ...overrides,
  })
}

test.group('Redactor | keys', () => {
  test('redact a top-level and a nested secret and leave the input untouched', ({ assert }) => {
    const input = { password: 'x', nested: { api_key: 'y' } }

    const result = redactor().redact(input)

    assert.deepEqual(result, {
      password: '[REDACTED]',
      nested: { api_key: '[REDACTED]' },
    })
    assert.deepEqual(input, { password: 'x', nested: { api_key: 'y' } })
  })

  test('return a new structure rather than mutating the caller object', ({ assert }) => {
    const nested = { api_key: 'y' }
    const input = { password: 'x', nested, safe: { keep: 1 } }

    const result = redactor().redact(input)

    assert.notStrictEqual(result, input)
    assert.notStrictEqual(result.nested, nested)
    assert.notStrictEqual(result.safe, input.safe)
    assert.equal(nested.api_key, 'y')
  })

  test('match keys through case, underscores, hyphens and spaces', ({ assert }) => {
    const scrubber = redactor({ keys: ['apiKey'] })

    const result = scrubber.redact({
      'api_key': 'a',
      'API-KEY': 'b',
      'api key': 'c',
      'apikey': 'd',
      'apiKey': 'e',
    })

    assert.deepEqual(result, {
      'api_key': '[REDACTED]',
      'API-KEY': '[REDACTED]',
      'api key': '[REDACTED]',
      'apikey': '[REDACTED]',
      'apiKey': '[REDACTED]',
    })
  })

  test('match whole keys only, so passwordHint survives', ({ assert }) => {
    const result = redactor().redact({ passwordHint: 'mother maiden name', password: 'x' })

    assert.deepEqual(result, { passwordHint: 'mother maiden name', password: '[REDACTED]' })
  })

  test('redact inside arrays at any depth', ({ assert }) => {
    const input = { users: [{ token: 't' }, { name: 'ada', nested: [{ secret: 's' }] }] }

    const result = redactor().redact(input)

    assert.deepEqual(result, {
      users: [{ token: '[REDACTED]' }, { name: 'ada', nested: [{ secret: '[REDACTED]' }] }],
    })
    assert.deepEqual(input.users[0], { token: 't' })
  })

  test('replace the value of a matching key whatever its type', ({ assert }) => {
    const result = redactor().redact({
      password: 12345,
      token: { access: 'a', refresh: 'b' },
      secret: ['a', 'b'],
      cookie: null,
      auth: undefined,
    })

    assert.deepEqual(result, {
      password: '[REDACTED]',
      token: '[REDACTED]',
      secret: '[REDACTED]',
      cookie: '[REDACTED]',
      auth: '[REDACTED]',
    })
  })

  test('walk unbounded depth, leaving depth capping to the serializer', ({ assert }) => {
    const leaf: Record<string, unknown> = { password: 'deep' }
    let input: Record<string, unknown> = leaf
    for (let level = 0; level < 200; level++) {
      input = { child: input }
    }

    let cursor = redactor().redact(input)
    for (let level = 0; level < 200; level++) {
      cursor = cursor.child as Record<string, unknown>
    }

    assert.deepEqual(cursor, { password: '[REDACTED]' })
  })

  test('return non-plain values by identity', ({ assert }) => {
    class Model {
      id = 1
    }

    const date = new Date('2026-07-25T00:00:00.000Z')
    const buffer = Buffer.from('payload')
    const model = new Model()
    const callback = () => 'noop'
    const map = new Map([['k', 'v']])

    const result = redactor().redact({ date, buffer, model, callback, map, count: 3, flag: false })

    assert.strictEqual(result.date, date)
    assert.strictEqual(result.buffer, buffer)
    assert.strictEqual(result.model, model)
    assert.strictEqual(result.callback, callback)
    assert.strictEqual(result.map, map)
    assert.strictEqual(result.count, 3)
    assert.strictEqual(result.flag, false)
  })

  test('return a non-plain root by identity', ({ assert }) => {
    const date = new Date('2026-07-25T00:00:00.000Z')

    assert.strictEqual(redactor().redact(date), date)
    assert.strictEqual(redactor().redact('password'), 'password')
    assert.isNull(redactor().redact(null))
  })

  test('never inspect a class instance holding a secret', ({ assert }) => {
    class Credentials {
      password = 'x'
    }

    const credentials = new Credentials()
    const result = redactor().redact({ credentials })

    assert.strictEqual(result.credentials, credentials)
  })

  test('replace a cycle with the circular marker instead of hanging', ({ assert }) => {
    const input: Record<string, unknown> = { name: 'root', password: 'x' }
    input.self = input

    const result = redactor().redact(input)

    assert.deepEqual(result, { name: 'root', password: '[REDACTED]', self: '[Circular]' })
  })

  test('replace a cycle reached through an array', ({ assert }) => {
    const items: unknown[] = ['first']
    items.push(items)
    const input = { items }

    const result = redactor().redact(input)

    assert.deepEqual(result, { items: ['first', '[Circular]'] })
  })

  test('walk a value shared between siblings rather than calling it circular', ({ assert }) => {
    const shared = { token: 't' }

    const result = redactor().redact({ left: shared, right: shared })

    assert.deepEqual(result, { left: { token: '[REDACTED]' }, right: { token: '[REDACTED]' } })
  })

  test('scrub every default key', ({ assert }) => {
    const scrubber = redactor()

    for (const key of DEFAULT_REDACT_KEYS) {
      assert.deepEqual(scrubber.redact({ [key]: 'leak' }), { [key]: '[REDACTED]' }, key)
    }
  })

  test('property: no configured deny key survives at any generated nesting depth', () => {
    const denied = new Set(
      DEFAULT_REDACT_KEYS.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ''))
    )
    const key = fc.constantFrom(
      ...DEFAULT_REDACT_KEYS.flatMap((item) => [
        item,
        item.toUpperCase(),
        [...item].join('_'),
        [...item].join('-'),
      ])
    )
    const nestedSecret = fc
      .tuple(
        key,
        fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
        fc.jsonValue({ maxDepth: 8 })
      )
      .map(([secretKey, branches, noise]) => {
        let value: unknown = { [secretKey]: 'plaintext-secret' }

        for (const arrayBranch of branches) {
          value = arrayBranch ? [noise, value] : { noise, nested: value }
        }

        return value
      })
    const assertRedacted = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(assertRedacted)
        return
      }

      if (value === null || typeof value !== 'object') return

      for (const [name, nested] of Object.entries(value)) {
        const normalised = name.toLowerCase().replace(/[^a-z0-9]/g, '')
        if (denied.has(normalised)) {
          if (nested !== '[REDACTED]') {
            throw new Error(`deny-listed key ${JSON.stringify(name)} retained an unredacted value`)
          }
        } else {
          assertRedacted(nested)
        }
      }
    }
    const scrubber = redactor()

    fc.assert(
      fc.property(nestedSecret, (input) => {
        assertRedacted(scrubber.redact(input))
      }),
      { numRuns: 1_000 }
    )
  })

  test('honour a custom replacement string', ({ assert }) => {
    const result = redactor({ replacement: '***' }).redact({ password: 'x' })

    assert.deepEqual(result, { password: '***' })
  })

  test('disable key redaction when the key list is empty', ({ assert }) => {
    const input = { password: 'x', nested: { api_key: 'y' } }

    const result = redactor({ keys: [] }).redact(input)

    assert.strictEqual(result, input)
  })

  test('ignore a configured key that normalises to nothing', ({ assert }) => {
    const result = redactor({ keys: ['---'] }).redact({ ___: 'kept', password: 'kept' })

    assert.deepEqual(result, { ___: 'kept', password: 'kept' })
  })

  /**
   * `JSON.parse` is the point: it is the only common way to end up with an own, enumerable
   * `__proto__` property, and it is exactly how a recorded request body reaches the redactor.
   * A bare `result[key] = ...` would hit the prototype setter and drop the whole subtree on the
   * floor, so the descriptor — not the value read back — is what this pins.
   */
  test('keep an own __proto__ key as a data property and redact inside it', ({ assert }) => {
    const input: Record<string, unknown> = JSON.parse(
      '{"__proto__": {"password": "x", "keep": 2}, "safe": 1}'
    )

    const result = redactor().redact(input)

    const descriptor = Object.getOwnPropertyDescriptor(result, '__proto__')
    assert.isDefined(descriptor)
    assert.isTrue(descriptor?.enumerable)
    assert.deepEqual(descriptor?.value, { password: '[REDACTED]', keep: 2 })
    assert.strictEqual(Object.getPrototypeOf(result), Object.prototype)
    assert.equal(result.safe, 1)
  })

  test('keep an own __proto__ key that is itself a matching secret', ({ assert }) => {
    const input: Record<string, unknown> = JSON.parse('{"__proto__": {"a": 1}}')

    const result = redactor({ keys: ['__proto__'] }).redact(input)

    assert.equal(Object.getOwnPropertyDescriptor(result, '__proto__')?.value, '[REDACTED]')
    assert.strictEqual(Object.getPrototypeOf(result), Object.prototype)
  })

  test('keep an own __proto__ key nested below a walked object', ({ assert }) => {
    const input: Record<string, unknown> = JSON.parse('{"body": {"__proto__": {"token": "t"}}}')

    const result = redactor().redact(input)

    const body = result.body as Record<string, unknown>
    assert.strictEqual(Object.getPrototypeOf(body), Object.prototype)
    assert.deepEqual(Object.getOwnPropertyDescriptor(body, '__proto__')?.value, {
      token: '[REDACTED]',
    })
  })

  test('keep an own __proto__ key on an object inside an array', ({ assert }) => {
    const input: Record<string, unknown> = JSON.parse('{"items": [{"__proto__": {"pin": "1234"}}]}')

    const result = redactor({ keys: ['pin'] }).redact(input)

    const first = (result.items as Record<string, unknown>[])[0]
    assert.strictEqual(Object.getPrototypeOf(first), Object.prototype)
    assert.deepEqual(Object.getOwnPropertyDescriptor(first, '__proto__')?.value, {
      pin: '[REDACTED]',
    })
  })
})

test.group('Redactor | headers', () => {
  test('redact configured headers case-insensitively and pass the rest through', ({ assert }) => {
    const input = {
      'Authorization': 'Bearer abc',
      'COOKIE': 'session=1',
      'content-type': 'application/json',
      'x-request-id': 'req-1',
    }

    const result = redactor().redactHeaders(input)

    assert.deepEqual(result, {
      'Authorization': '[REDACTED]',
      'COOKIE': '[REDACTED]',
      'content-type': 'application/json',
      'x-request-id': 'req-1',
    })
    assert.equal(input.Authorization, 'Bearer abc')
    assert.notStrictEqual(result, input)
  })

  test('match header names exactly rather than by alphanumeric normalisation', ({ assert }) => {
    const result = redactor().redactHeaders({ 'x-api-key': 'k', 'xapikey': 'k', 'apikey': 'k' })

    assert.deepEqual(result, { 'x-api-key': '[REDACTED]', 'xapikey': 'k', 'apikey': 'k' })
  })

  test('collapse an array-valued header to a single replacement', ({ assert }) => {
    const result = redactor().redactHeaders({
      'set-cookie': ['a=1; HttpOnly', 'b=2; HttpOnly'],
      'vary': ['accept', 'origin'],
    })

    assert.deepEqual(result, { 'set-cookie': '[REDACTED]', 'vary': ['accept', 'origin'] })
  })

  test('pass non-matching header values through by identity', ({ assert }) => {
    const vary = ['accept', 'origin']

    const result = redactor().redactHeaders({ vary })

    assert.strictEqual(result.vary, vary)
  })

  test('scrub every default header', ({ assert }) => {
    const scrubber = redactor()

    for (const header of DEFAULT_REDACT_HEADERS) {
      assert.deepEqual(scrubber.redactHeaders({ [header]: 'leak' }), { [header]: '[REDACTED]' })
    }
  })

  test('honour a custom replacement string', ({ assert }) => {
    const result = redactor({ replacement: '***' }).redactHeaders({ cookie: 'session=1' })

    assert.deepEqual(result, { cookie: '***' })
  })

  test('disable header redaction when the header list is empty', ({ assert }) => {
    const input = { authorization: 'Bearer abc' }

    const result = redactor({ headers: [] }).redactHeaders(input)

    assert.strictEqual(result, input)
  })

  test('leave nested header-like keys to redact() only', ({ assert }) => {
    const result = redactor().redactHeaders({ meta: { authorization: 'Bearer abc' } })

    assert.deepEqual(result, { meta: { authorization: 'Bearer abc' } })
  })

  /**
   * A client controls its own header names, so `__proto__` arrives as a header just as easily
   * as it does as a body key. Node hands the value over as a string or an array of strings; a
   * plain assignment would silently discard the former and retarget the copy's prototype on the
   * latter. The header map is built with `JSON.parse` because an object literal's `__proto__:`
   * entry sets the prototype instead of creating the own property under test.
   */
  test('keep a __proto__ header as an own data property', ({ assert }) => {
    const input: Record<string, unknown> = JSON.parse(
      '{"__proto__": ["a=1"], "x-request-id": "req-1"}'
    )

    const result = redactor().redactHeaders(input)

    assert.deepEqual(Object.getOwnPropertyDescriptor(result, '__proto__')?.value, ['a=1'])
    assert.strictEqual(Object.getPrototypeOf(result), Object.prototype)
    assert.equal(result['x-request-id'], 'req-1')
  })

  test('redact a __proto__ header that is on the deny list', ({ assert }) => {
    const input: Record<string, unknown> = JSON.parse('{"__proto__": "leak"}')

    const result = redactor({ headers: ['__proto__'] }).redactHeaders(input)

    assert.equal(Object.getOwnPropertyDescriptor(result, '__proto__')?.value, '[REDACTED]')
    assert.strictEqual(Object.getPrototypeOf(result), Object.prototype)
  })
})
