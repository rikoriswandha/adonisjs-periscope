/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { test } from '@japa/runner'

import { IncomingEntry } from '../../../src/entry.ts'
import { AmbientBatch } from '../../../src/recorder/ambient.ts'
import type { AmbientBatchOptions } from '../../../src/recorder/ambient.ts'
import { setInternalLogger } from '../../../src/safeguard.ts'
import type { BatchContext } from '../../../src/types.ts'
import { EntryType } from '../../../src/types.ts'

/**
 * Every batch built by a test, so the teardown can disarm timers even when the test failed
 * half-way through. The timers are `unref`ed and therefore harmless, but a leaked one would keep
 * rotating into the *next* test's flush callback.
 */
const started = new Set<AmbientBatch>()

function makeBatch(options: AmbientBatchOptions): AmbientBatch {
  const batch = new AmbientBatch(options)

  started.add(batch)

  return batch
}

/**
 * Poll instead of sleeping a fixed amount: the positive path finishes as soon as the timer has
 * fired, and the negative path fails with a message rather than a bare assertion mismatch.
 */
async function waitUntil(predicate: () => boolean, reason: string): Promise<void> {
  const deadline = Date.now() + 2000

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${reason}`)
    }

    await sleep(1)
  }
}

test.group('AmbientBatch', (group) => {
  group.each.teardown(async () => {
    for (const batch of started) {
      await batch.stop()
    }

    started.clear()
    setInternalLogger(null)
  })

  test('expose one stable ambient context before any rotation', ({ assert }) => {
    const batch = makeBatch({ rotationMs: 5, flush: () => {} })

    assert.strictEqual(batch.current(), batch.current())
    assert.equal(batch.current().kind, 'ambient')
    assert.isFalse(batch.current().muted)
    assert.isFalse(batch.running)
  })

  test('hand the retired context to flush and install a fresh one', async ({ assert }) => {
    const flushed: BatchContext[] = []
    const batch = makeBatch({
      rotationMs: 5,
      flush: (context) => {
        flushed.push(context)
      },
    })

    const retired = batch.current()
    retired.buffer.push(IncomingEntry.make(EntryType.LOG))

    await batch.rotate()

    assert.lengthOf(flushed, 1)
    assert.strictEqual(flushed[0], retired)

    assert.notStrictEqual(batch.current(), retired)
    assert.notEqual(batch.current().batchId, retired.batchId)
    assert.equal(batch.current().kind, 'ambient')
    assert.isEmpty(batch.current().buffer)
  })

  test('buffer entries recorded during an in-flight flush into the new context', async ({
    assert,
  }) => {
    let release = (): void => {}
    const storeWrite = new Promise<void>((resolve) => {
      release = resolve
    })

    let contextDuringFlush: BatchContext | undefined
    let retiredSizeDuringFlush = 0

    const batch = makeBatch({
      rotationMs: 5,
      flush: async (retiredContext) => {
        // A watcher fires while the store write is still in flight.
        contextDuringFlush = batch.current()
        contextDuringFlush.buffer.push(IncomingEntry.make(EntryType.EVENT))
        retiredSizeDuringFlush = retiredContext.buffer.length

        await storeWrite
      },
    })

    const retired = batch.current()
    retired.buffer.push(IncomingEntry.make(EntryType.LOG))

    const rotation = batch.rotate()
    release()
    await rotation

    assert.notStrictEqual(contextDuringFlush, retired)
    assert.strictEqual(batch.current(), contextDuringFlush)

    // The late entry landed in the new context, and the flushed one was never appended to.
    assert.equal(retiredSizeDuringFlush, 1)
    assert.lengthOf(retired.buffer, 1)
    assert.lengthOf(batch.current().buffer, 1)
    assert.equal(batch.current().buffer[0].type, EntryType.EVENT)
  })

  test('skip the flush when the retired context is empty', async ({ assert }) => {
    let calls = 0
    const batch = makeBatch({
      rotationMs: 5,
      flush: () => {
        calls += 1
      },
    })

    await batch.rotate()
    assert.equal(calls, 0)

    // ...but a non-empty one still reaches the store, so the guard is not simply dead.
    batch.current().buffer.push(IncomingEntry.make(EntryType.LOG))
    await batch.rotate()
    assert.equal(calls, 1)
  })

  test('rotate on the interval once started', async ({ assert }) => {
    const flushed: BatchContext[] = []
    const batch = makeBatch({
      rotationMs: 2,
      flush: (context) => {
        flushed.push(context)
      },
    })

    const retired = batch.current()
    retired.buffer.push(IncomingEntry.make(EntryType.LOG))

    batch.start()
    assert.isTrue(batch.running)

    await waitUntil(() => flushed.length > 0, 'the rotation timer to fire')

    assert.strictEqual(flushed[0], retired)
  })

  test('arm a single rotation timer when start is called twice', async ({ assert }) => {
    const flushed: BatchContext[] = []
    const batch = makeBatch({
      rotationMs: 2,
      flush: (context) => {
        flushed.push(context)
      },
    })

    batch.start()
    batch.start()
    assert.isTrue(batch.running)

    await batch.stop()
    assert.isFalse(batch.running)

    // `stop()` only ever clears the timer it remembers, so a second, forgotten interval would
    // keep rotating — and keep flushing — long after the batch was stopped.
    const flushesAtStop = flushed.length
    batch.current().buffer.push(IncomingEntry.make(EntryType.LOG))
    await sleep(30)

    assert.lengthOf(flushed, flushesAtStop)
  })

  test('flush whatever is buffered when stopping', async ({ assert }) => {
    const flushed: BatchContext[] = []
    const batch = makeBatch({
      rotationMs: 5,
      flush: (context) => {
        flushed.push(context)
      },
    })

    const open = batch.current()
    open.buffer.push(IncomingEntry.make(EntryType.LOG))

    batch.start()
    await batch.stop()

    assert.isFalse(batch.running)
    assert.lengthOf(flushed, 1)
    assert.strictEqual(flushed[0], open)
  })

  test('stay idempotent when stopped twice', async ({ assert }) => {
    const flushed: BatchContext[] = []
    const batch = makeBatch({
      rotationMs: 5,
      flush: (context) => {
        flushed.push(context)
      },
    })

    batch.current().buffer.push(IncomingEntry.make(EntryType.LOG))
    batch.start()

    await batch.stop()
    await batch.stop()

    assert.isFalse(batch.running)
    assert.lengthOf(flushed, 1)
  })

  test('stop safely when it was never started', async ({ assert }) => {
    const flushed: BatchContext[] = []
    const batch = makeBatch({
      rotationMs: 5,
      flush: (context) => {
        flushed.push(context)
      },
    })

    await batch.stop()

    assert.isFalse(batch.running)
    assert.lengthOf(flushed, 0)
  })

  test('swallow and report a flush failure raised while stopping', async ({ assert }) => {
    const failures: string[] = []
    setInternalLogger((label) => failures.push(label))

    const batch = makeBatch({
      rotationMs: 5,
      flush: () => {
        throw new Error('the store is gone')
      },
    })

    batch.current().buffer.push(IncomingEntry.make(EntryType.LOG))

    await batch.stop()

    assert.isFalse(batch.running)
    assert.deepEqual(failures, ['periscope.ambient'])
  })

  test('swallow and report a flush failure raised from the rotation timer', async ({ assert }) => {
    const failures: string[] = []
    setInternalLogger((label) => failures.push(label))

    const batch = makeBatch({
      rotationMs: 2,
      flush: () => Promise.reject(new Error('the store is gone')),
    })

    batch.current().buffer.push(IncomingEntry.make(EntryType.LOG))
    batch.start()

    await waitUntil(() => failures.length > 0, 'the rotation timer to report a flush failure')

    assert.equal(failures[0], 'periscope.ambient')
    assert.isTrue(batch.running)
  })

  test('surface a flush failure to a direct rotate caller', async ({ assert }) => {
    const batch = makeBatch({
      rotationMs: 5,
      flush: () => {
        throw new Error('the store is gone')
      },
    })

    batch.current().buffer.push(IncomingEntry.make(EntryType.LOG))

    await assert.rejects(() => batch.rotate(), /the store is gone/)

    // The swap still happened, so the failed batch is not retried forever.
    assert.isEmpty(batch.current().buffer)
  })

  test('wait for an in-flight rotation before stop resolves', async ({ assert }) => {
    let openGate = (): void => {}
    const storeWrite = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const order: string[] = []
    const flushed: BatchContext[] = []

    const batch = makeBatch({
      rotationMs: 5,
      flush: async (context) => {
        order.push('flush:start')
        await storeWrite
        flushed.push(context)
        order.push('flush:end')
      },
    })

    const retired = batch.current()
    retired.buffer.push(IncomingEntry.make(EntryType.LOG))

    batch.start()
    await waitUntil(() => order.length > 0, 'the rotation timer to start a flush')

    let stopped = false
    const stopping = batch.stop().then(() => {
      stopped = true
      order.push('stop')
    })

    // The context `stop()` retires itself is empty, so its own rotation has nothing to flush: the
    // only thing that can hold it back is the rotation the timer already started. Draining a few
    // event loop turns is more than enough for a `stop()` that ignores that rotation to resolve,
    // while the gate keeps a correct one waiting for as long as we care to look — which is what
    // makes the negative assertion deterministic rather than a race against a sleep.
    await sleep(20)

    assert.isFalse(stopped, 'stop() resolved while a rotation flush was still in flight')
    assert.lengthOf(flushed, 0)

    openGate()
    await stopping

    // The order, not just the end state: shutdown closes the store the moment `stop()` resolves,
    // so resolving beside the write rather than after it is already data loss.
    assert.deepEqual(order, ['flush:start', 'flush:end', 'stop'])
    assert.lengthOf(flushed, 1)
    assert.strictEqual(flushed[0], retired)
    assert.isFalse(batch.running)
  })

  test('flush entries recorded during an in-flight rotation when stopping', async ({ assert }) => {
    let openGate = (): void => {}
    const storeWrite = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const flushed: BatchContext[] = []
    const batch = makeBatch({
      rotationMs: 5,
      flush: async (context) => {
        await storeWrite
        flushed.push(context)
      },
    })

    const first = batch.current()
    first.buffer.push(IncomingEntry.make(EntryType.LOG))

    batch.start()
    await waitUntil(
      () => batch.current() !== first,
      'the rotation timer to retire the first context'
    )

    // A watcher fires while the store write is still gated. Nothing has retired this context yet,
    // so `stop()` owes it a flush on top of waiting for the one in flight.
    const late = batch.current()
    late.buffer.push(IncomingEntry.make(EntryType.EVENT))

    const stopping = batch.stop()
    openGate()
    await stopping

    assert.lengthOf(flushed, 2)
    assert.strictEqual(flushed[0], first)
    assert.strictEqual(flushed[1], late)
    assert.isEmpty(batch.current().buffer)
  })

  test('queue an overlapping rotation behind the running one', async ({ assert }) => {
    let openGate = (): void => {}
    const storeWrite = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const order: string[] = []
    const batch = makeBatch({
      rotationMs: 5,
      flush: async (context) => {
        const label = context.buffer[0].type

        order.push(`start:${label}`)
        await storeWrite
        order.push(`end:${label}`)
      },
    })

    batch.current().buffer.push(IncomingEntry.make(EntryType.LOG))
    const firstRotation = batch.rotate()

    const second = batch.current()
    second.buffer.push(IncomingEntry.make(EntryType.EVENT))
    const secondRotation = batch.rotate()

    // The second rotation has not swapped anything yet. If it had, `second` would be retired while
    // the first flush is still running, and a watcher firing right now would be writing into a
    // context that is already on its way to the store.
    assert.strictEqual(batch.current(), second)
    assert.deepEqual(order, ['start:log'])

    openGate()
    await Promise.all([firstRotation, secondRotation])

    assert.deepEqual(order, ['start:log', 'end:log', 'start:event', 'end:event'])
    assert.notStrictEqual(batch.current(), second)
    assert.isEmpty(batch.current().buffer)
  })

  test('run a queued rotation even when the one ahead of it failed', async ({ assert }) => {
    let openGate = (): void => {}
    const storeWrite = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const flushed: BatchContext[] = []
    const batch = makeBatch({
      rotationMs: 5,
      flush: async (context) => {
        await storeWrite

        if (context.buffer[0].type === EntryType.LOG) {
          throw new Error('the store is gone')
        }

        flushed.push(context)
      },
    })

    batch.current().buffer.push(IncomingEntry.make(EntryType.LOG))
    const failingRotation = batch.rotate()

    const second = batch.current()
    second.buffer.push(IncomingEntry.make(EntryType.EVENT))
    const secondRotation = batch.rotate()

    // Armed before the gate opens, so the rejection is never momentarily unhandled.
    const rejection = assert.rejects(() => failingRotation, /the store is gone/)

    openGate()
    await rejection
    await secondRotation

    // A dead store must not wedge the queue: the failure belongs to the caller that asked for that
    // rotation, and the next one still gets its swap and its flush.
    assert.lengthOf(flushed, 1)
    assert.strictEqual(flushed[0], second)
  })
})
