/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'

import { nextSequence } from '../../../src/recorder/sequence.ts'

/**
 * How far a sequence value may sit from `Date.now()` before we call the wall-clock anchoring
 * broken. Generous on purpose: the anchor is captured at module load, and a loaded CI box can
 * put seconds between that and the assertion. A regression to a bare `process.hrtime.bigint()`
 * would be off by the process uptime — or, on a long-lived box, by the machine uptime — so the
 * test still catches the mistake it exists to catch.
 */
const ANCHOR_TOLERANCE_NS = 2_000_000_000n

test.group('Sequence', () => {
  test('produce strictly increasing values across a tight loop', ({ assert }) => {
    const iterations = 10_000
    let previous = nextSequence()
    let increasing = 0

    for (let index = 1; index < iterations; index++) {
      const current = nextSequence()

      if (current > previous) {
        increasing++
      }

      previous = current
    }

    assert.equal(
      increasing,
      iterations - 1,
      'every call must return a value strictly greater than the previous one'
    )
  })

  test('anchor values to the wall clock', ({ assert }) => {
    const wallClockNs = BigInt(Date.now()) * 1_000_000n
    const drift = nextSequence() - wallClockNs

    assert.isTrue(
      drift < ANCHOR_TOLERANCE_NS && drift > -ANCHOR_TOLERANCE_NS,
      `expected a value within 2s of the wall clock, drifted by ${drift}ns`
    )
  })

  test('return nanosecond-resolution values rather than millisecond ties', ({ assert }) => {
    const samples = new Set<bigint>()

    for (let index = 0; index < 1_000; index++) {
      samples.add(nextSequence())
    }

    assert.equal(samples.size, 1_000, 'sequence values must never collide')
  })
})
