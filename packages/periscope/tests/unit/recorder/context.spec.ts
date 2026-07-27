/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

import { test } from '@japa/runner'
import { context as otelContext, ROOT_CONTEXT, trace } from '@opentelemetry/api'
import type { Context, ContextManager } from '@opentelemetry/api'

import { IncomingEntry } from '../../../src/entry.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import type { BatchContext } from '../../../src/types.ts'
import { EntryType } from '../../../src/types.ts'

/**
 * Narrowing helper. Every assertion below reads the active context, and `current()` is optional
 * by design, so this keeps the tests free of non-null assertions while still failing loudly (and
 * with a useful message) if a scope silently went missing.
 */
function currentOrFail(): BatchContext {
  const context = BatchScope.current()

  if (context === undefined) {
    throw new Error('expected a batch context to be active')
  }

  return context
}

/**
 * Stand-in for the recorder's final pipeline step (P1.3 owns the real one). It does the single
 * thing these tests are about: attribute an entry to whatever batch happens to be current.
 */
function record(): IncomingEntry {
  const context = currentOrFail()
  const entry = IncomingEntry.make(EntryType.LOG).stamp(context.batchId, 1n)

  context.buffer.push(entry)

  return entry
}

test.group('BatchScope | contexts', (group) => {
  group.each.setup(() => {
    BatchScope.configureSampling(1)
  })

  test('create a context of the requested kind with empty bookkeeping', ({ assert }) => {
    const context = BatchScope.createContext('command')

    assert.equal(context.kind, 'command')
    assert.isFalse(context.muted)
    assert.isTrue(context.sampled)
    assert.equal(context.retention, 'pending')
    assert.isEmpty(context.buffer)
    assert.deepEqual(context.counters, {})
    assert.deepEqual(context.truncated, {})
    assert.isTrue(context.startedAt > 0n)
  })

  test('capture a valid active OpenTelemetry trace identifier', ({ assert }) => {
    let activeContext: Context = ROOT_CONTEXT
    const manager: ContextManager = {
      active: () => activeContext,
      with(contextValue, callback, thisArg, ...args) {
        const previous = activeContext
        activeContext = contextValue
        try {
          return callback.call(thisArg, ...args)
        } finally {
          activeContext = previous
        }
      },
      bind: (_contextValue, target) => target,
      enable() {
        return this
      },
      disable() {
        activeContext = ROOT_CONTEXT
        return this
      },
    }
    assert.isTrue(otelContext.setGlobalContextManager(manager))

    try {
      const tracedContext = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
        traceFlags: 1,
      })
      const batch = otelContext.with(tracedContext, () => BatchScope.createContext('request'))

      assert.equal(batch.traceId, '0123456789abcdef0123456789abcdef')
    } finally {
      otelContext.disable()
    }
  })

  test('give every created context its own batch id', ({ assert }) => {
    assert.notEqual(
      BatchScope.createContext('ambient').batchId,
      BatchScope.createContext('ambient').batchId
    )
  })

  test('expose no context outside a scope', ({ assert }) => {
    assert.isUndefined(BatchScope.current())

    BatchScope.run('request', () => {})

    assert.isUndefined(BatchScope.current())
  })

  test('share one batch id between entries recorded in the same scope', ({ assert }) => {
    const context = BatchScope.run('request', () => {
      record()
      record()

      return currentOrFail()
    })

    assert.lengthOf(context.buffer, 2)
    assert.equal(context.buffer[0].batchId, context.batchId)
    assert.equal(context.buffer[1].batchId, context.batchId)
  })

  test('give sibling scopes distinct batch ids', ({ assert }) => {
    const first = BatchScope.run('request', () => currentOrFail().batchId)
    const second = BatchScope.run('request', () => currentOrFail().batchId)

    assert.notEqual(first, second)
  })

  test('shadow the parent scope from a nested one and restore it on exit', ({ assert }) => {
    BatchScope.run('request', () => {
      const parent = currentOrFail()

      BatchScope.run('queue', () => {
        assert.notStrictEqual(currentOrFail(), parent)
        assert.equal(currentOrFail().kind, 'queue')
      })

      assert.strictEqual(currentOrFail(), parent)
    })
  })

  test('return the value produced by the callback of runWith', ({ assert }) => {
    const context = BatchScope.createContext('test')

    assert.equal(
      BatchScope.runWith(context, () => 42),
      42
    )
  })

  test('enter the exact context handed to runWith', async ({ assert }) => {
    const context = BatchScope.createContext('test')

    const seen = await BatchScope.runWith(context, async () => {
      await sleep(1)

      return currentOrFail()
    })

    assert.strictEqual(seen, context)
    assert.isUndefined(BatchScope.current())
  })
})

test.group('BatchScope | async propagation', () => {
  test('inherit the context across an awaited promise chain', async ({ assert }) => {
    await BatchScope.run('request', async () => {
      const expected = currentOrFail().batchId

      await Promise.resolve()
      assert.equal(currentOrFail().batchId, expected)

      const seen = await Promise.resolve()
        .then(() => sleep(1))
        .then(() => BatchScope.current()?.batchId)

      assert.equal(seen, expected)
    })
  })

  test('inherit the context inside a queued microtask', async ({ assert }) => {
    let expected = ''

    const seen = await BatchScope.run('request', () => {
      expected = currentOrFail().batchId

      return new Promise<string | undefined>((resolve) => {
        queueMicrotask(() => resolve(BatchScope.current()?.batchId))
      })
    })

    assert.equal(seen, expected)
  })

  test('inherit the context inside a setTimeout callback', async ({ assert }) => {
    let expected = ''

    const seen = await BatchScope.run('queue', () => {
      expected = currentOrFail().batchId

      return new Promise<string | undefined>((resolve) => {
        setTimeout(() => resolve(BatchScope.current()?.batchId), 1)
      })
    })

    assert.equal(seen, expected)
  })

  test('inherit the context inside an asynchronously invoked emitter listener', async ({
    assert,
  }) => {
    const emitter = new EventEmitter()
    let expected = ''

    const seen = await BatchScope.run('command', () => {
      expected = currentOrFail().batchId

      return new Promise<string | undefined>((resolve) => {
        emitter.on('done', () => resolve(BatchScope.current()?.batchId))
        setTimeout(() => emitter.emit('done'), 1)
      })
    })

    assert.equal(seen, expected)
  })
})

test.group('BatchScope | mute', () => {
  test('report the context as muted inside mute', ({ assert }) => {
    BatchScope.run('request', () => {
      assert.isFalse(currentOrFail().muted)

      BatchScope.mute(() => {
        assert.isTrue(currentOrFail().muted)
      })
    })
  })

  test('keep the outer batch id and kind so internal work still correlates', ({ assert }) => {
    BatchScope.run('queue', () => {
      const outer = currentOrFail()

      BatchScope.mute(() => {
        assert.equal(currentOrFail().batchId, outer.batchId)
        assert.equal(currentOrFail().kind, 'queue')
      })
    })
  })

  test('give the muted child its own buffer, counters and truncated', ({ assert }) => {
    BatchScope.run('command', () => {
      const outer = currentOrFail()

      record()
      outer.counters.log = 1
      outer.truncated.log = 2

      BatchScope.mute(() => {
        const child = currentOrFail()

        assert.notStrictEqual(child.buffer, outer.buffer)
        assert.notStrictEqual(child.counters, outer.counters)
        assert.notStrictEqual(child.truncated, outer.truncated)
        assert.isEmpty(child.buffer)
        assert.deepEqual(child.counters, {})
        assert.deepEqual(child.truncated, {})

        record()
        child.counters.query = 7
        child.truncated.query = 9
      })

      assert.lengthOf(outer.buffer, 1)
      assert.deepEqual(outer.counters, { log: 1 })
      assert.deepEqual(outer.truncated, { log: 2 })
    })
  })

  test('fall back to a fresh ambient context when nothing is active', ({ assert }) => {
    assert.isUndefined(BatchScope.current())

    const child = BatchScope.mute(() => currentOrFail())

    assert.equal(child.kind, 'ambient')
    assert.isTrue(child.muted)
    assert.isEmpty(child.buffer)
    assert.isUndefined(BatchScope.current())
  })

  test('restore the unmuted outer context once mute returns', ({ assert }) => {
    BatchScope.run('request', () => {
      const outer = currentOrFail()

      BatchScope.mute(() => {})

      assert.strictEqual(currentOrFail(), outer)
      assert.isFalse(outer.muted)
      assert.isFalse(currentOrFail().muted)
    })
  })

  test('restore the outer context when the muted callback throws', ({ assert }) => {
    BatchScope.run('request', () => {
      const outer = currentOrFail()

      assert.throws(() => {
        BatchScope.mute(() => {
          throw new Error('boom')
        })
      }, 'boom')

      assert.strictEqual(currentOrFail(), outer)
      assert.isFalse(outer.muted)
    })
  })

  test('keep the muted context current across awaits inside mute', async ({ assert }) => {
    await BatchScope.run('request', async () => {
      const outer = currentOrFail()

      const seen = await BatchScope.mute(async () => {
        await sleep(1)

        const child = currentOrFail()

        return { batchId: child.batchId, muted: child.muted }
      })

      assert.isTrue(seen.muted)
      assert.equal(seen.batchId, outer.batchId)
      assert.isFalse(currentOrFail().muted)
    })
  })
})
