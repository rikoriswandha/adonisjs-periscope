/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'

import { createInProcessFanout } from '../../src/fanout.ts'
import { EntryType } from '../../src/types.ts'
import type { FlushedEvent } from '../../src/types.ts'

const event: FlushedEvent = {
  type: EntryType.LOG,
  uuid: 'entry-1',
  indexRow: {
    uuid: 'entry-1',
    batchId: 'batch-1',
    application: 'default',
    type: EntryType.LOG,
    familyHash: null,
    tags: [],
    shouldDisplayOnIndex: true,
    sequence: '1',
    createdAt: '2026-08-02T00:00:00.000Z',
  },
}

test.group('In-process flush fanout', () => {
  test('publishes synchronously, isolates listener failures, and unsubscribes idempotently', ({
    assert,
  }) => {
    const fanout = createInProcessFanout()
    const received: string[] = []
    const unsubscribe = fanout.subscribe(() => {
      received.push('first')
      throw new Error('listener failed')
    })
    fanout.subscribe(() => received.push('second'))

    fanout.publish(event)
    assert.deepEqual(received, ['first', 'second'])

    unsubscribe()
    unsubscribe()
    fanout.publish(event)
    assert.deepEqual(received, ['first', 'second', 'second'])
  })
})
