/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'

import { safeguard, safeguardAsync, setInternalLogger } from '../../src/safeguard.ts'

test.group('Safeguard', (group) => {
  group.each.teardown(() => {
    setInternalLogger(null)
  })

  test('return the value produced by the callback', ({ assert }) => {
    assert.equal(
      safeguard('unit', () => 42),
      42
    )
  })

  test('swallow a sync throw and return the fallback', ({ assert }) => {
    const result = safeguard(
      'unit',
      () => {
        throw new Error('boom')
      },
      'fallback'
    )

    assert.equal(result, 'fallback')
  })

  test('return undefined when a sync throw has no fallback', ({ assert }) => {
    const result = safeguard('unit', () => {
      throw new Error('boom')
    })

    assert.isUndefined(result)
  })

  test('report a sync throw through the injected internal logger', ({ assert }) => {
    const reported: { label: string; error: unknown }[] = []
    setInternalLogger((label, error) => reported.push({ label, error }))

    const failure = new Error('boom')
    safeguard('recorder.record', () => {
      throw failure
    })

    assert.lengthOf(reported, 1)
    assert.equal(reported[0].label, 'recorder.record')
    assert.strictEqual(reported[0].error, failure)
  })

  test('await and return the value of an async callback', async ({ assert }) => {
    const result = await safeguardAsync('unit', async () => 'ok')

    assert.equal(result, 'ok')
  })

  test('swallow an async rejection and report it', async ({ assert }) => {
    const reported: unknown[] = []
    setInternalLogger((_label, error) => reported.push(error))

    const failure = new Error('rejected')
    const result = await safeguardAsync('store.save', () => Promise.reject(failure), 'fallback')

    assert.equal(result, 'fallback')
    assert.deepEqual(reported, [failure])
  })

  test('never propagate a failure thrown by the internal logger itself', ({ assert }) => {
    setInternalLogger(() => {
      throw new Error('the reporter is broken too')
    })

    assert.doesNotThrow(() => {
      safeguard('unit', () => {
        throw new Error('boom')
      })
    })
  })
})
