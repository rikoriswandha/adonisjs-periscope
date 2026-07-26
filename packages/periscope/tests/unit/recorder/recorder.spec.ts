/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'

import { IncomingEntry } from '../../../src/entry.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder, TRIM_EVERY_FLUSHES } from '../../../src/recorder/recorder.ts'
import { DEFAULT_REDACT_HEADERS, DEFAULT_REDACT_KEYS } from '../../../src/recorder/redactor.ts'
import { setInternalLogger } from '../../../src/safeguard.ts'
import { ENTRY_TYPES, EntryType, Flag } from '../../../src/types.ts'
import type {
  EntryContent,
  EntryTypeCounts,
  FilterHook,
  Paginated,
  PeriscopeStore,
  ResolvedPeriscopeConfig,
  StoredEntry,
  TagHook,
} from '../../../src/types.ts'

/**
 * A hand-written {@link PeriscopeStore}. Deliberately not `MemoryStore`: this suite is about the
 * recorder's pipeline, and a real driver would couple these tests to a peer module's behaviour
 * and hide failures behind two layers at once. This double only has to record what it was asked
 * to do and fail when a test tells it to.
 */
class FakeStore implements PeriscopeStore {
  /**
   * Every `save()` call, in order, so a test can assert both what was written and how many
   * writes happened.
   */
  readonly saves: StoredEntry[][] = []

  /**
   * The `maxEntries` argument of every `trim()` call, in order. An array rather than a counter
   * because the interval tests care about *when* the recorder trims and the cap tests about
   * *what* it asked for, and both questions have the same answer only if nothing else trims.
   */
  readonly trims: number[] = []

  readonly #flags = new Map<string, string>()

  getFlagCalls = 0
  saveFailure: Error | null = null
  trimFailure: Error | null = null
  getFlagFailure: Error | null = null

  /**
   * Runs at the top of `save()`. Lets a test observe the world *during* a store write — which is
   * how the "the store's own activity is muted" invariant is checked.
   */
  onSave: (() => void) | null = null

  /**
   * Runs at the top of `getFlag()`, for the same reason {@link FakeStore.onSave} exists: the
   * pause-flag read is a store call, and a test has to be able to look at the batch context it
   * happens under.
   */
  onGetFlag: (() => void) | null = null

  /**
   * Runs at the top of `trim()`, so a test can inspect the batch context the maintenance delete
   * happens under — the trim is store traffic like the save, and is muted for the same reason.
   */
  onTrim: (() => void) | null = null

  async save(entries: StoredEntry[]): Promise<void> {
    this.onSave?.()

    if (this.saveFailure !== null) {
      throw this.saveFailure
    }

    this.saves.push(entries)
  }

  async find(): Promise<StoredEntry | null> {
    return null
  }

  async list(): Promise<Paginated<StoredEntry>> {
    return { data: [], nextCursor: null }
  }

  async batch(): Promise<StoredEntry[]> {
    return []
  }

  async counts(): Promise<EntryTypeCounts> {
    return {}
  }

  async prune(): Promise<number> {
    return 0
  }

  async trim(maxEntries: number): Promise<number> {
    this.onTrim?.()

    if (this.trimFailure !== null) {
      throw this.trimFailure
    }

    this.trims.push(maxEntries)

    return 0
  }

  async clear(): Promise<void> {}

  async monitoredTags(): Promise<string[]> {
    return []
  }

  async monitorTag(): Promise<void> {}

  async unmonitorTag(): Promise<void> {}

  async getFlag(name: string): Promise<string | null> {
    this.onGetFlag?.()

    this.getFlagCalls++

    if (this.getFlagFailure !== null) {
      throw this.getFlagFailure
    }

    return this.#flags.get(name) ?? null
  }

  async setFlag(name: string, value: string): Promise<void> {
    this.#flags.set(name, value)
  }

  async deleteFlag(name: string): Promise<void> {
    this.#flags.delete(name)
  }

  async close(): Promise<void> {}
}

type ConfigOverrides = {
  enabled?: boolean
  caps?: Partial<Record<EntryType, number>>
  ambientRotationMs?: number
  pausedFlagTtlMs?: number
  filter?: FilterHook[]
  tag?: TagHook[]

  /**
   * Emptying this turns redaction into a pass-through, which is how a test gets hold of the
   * *identity* of the content object a watcher handed over — `Redactor#redact` returns its
   * argument unchanged when it has no keys to scrub.
   */
  redactKeys?: string[]
}

/**
 * Build a {@link ResolvedPeriscopeConfig} by hand, matching the documented defaults.
 *
 * `defineConfig` is deliberately not used: the recorder must be testable against an arbitrary
 * resolved config, and routing every case through the resolver would make a config-validation
 * bug look like a recorder bug.
 */
function makeConfig(overrides: ConfigOverrides = {}): ResolvedPeriscopeConfig {
  const caps = {} as Record<EntryType, number>

  for (const type of ENTRY_TYPES) {
    caps[type] = overrides.caps?.[type] ?? (type === EntryType.QUERY ? 200 : 100)
  }

  return {
    enabled: overrides.enabled ?? true,
    enabledIn: ['development', 'test'],
    storage: { driver: 'memory', maxEntries: 10_000 },
    recording: {
      caps,
      ambientRotationMs: overrides.ambientRotationMs ?? 10_000,
      pausedFlagTtlMs: overrides.pausedFlagTtlMs ?? 5_000,
    },
    redact: {
      keys: overrides.redactKeys ?? [...DEFAULT_REDACT_KEYS],
      headers: [...DEFAULT_REDACT_HEADERS],
      replacement: '[REDACTED]',
    },
    hooks: { filter: overrides.filter ?? [], tag: overrides.tag ?? [] },
  }
}

/**
 * Yield to the macrotask queue, so the fire-and-forget flag refresh started by `recorder.paused`
 * has landed by the time the next assertion runs.
 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Sleep for `ms` as a macrotask. The timer-driven tests have to let real wall time pass: the
 * ambient rotation binds `setInterval` at module load, so there is no fake-timer seam to install
 * afterwards.
 */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * Poll until `condition` holds or `timeoutMs` elapses, returning either way — the assertion that
 * follows is what decides the test. The ambient rotation is driven by a real timer, so sleeping a
 * fixed multiple of the rotation window would be flaky on a loaded machine and slow everywhere
 * else; polling also gives the "and then nothing else happens" assertions a bounded cost.
 */
async function waitUntil(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!condition() && Date.now() < deadline) {
    await sleep(2)
  }
}

/**
 * Run `count` complete flushes, each with one entry buffered in a fresh request batch.
 *
 * The entry matters: only a flush that reaches the store counts towards the trim interval, so a
 * helper that flushed empty batches would never advance it. A fresh context per flush is what a
 * real application does — one batch per request — and proves the interval is the recorder's
 * state rather than any single batch's.
 */
async function flushBatches(recorder: Recorder, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG, { message: `flush ${index}` }))
    })

    await recorder.flush(context)
  }
}

test.group('Recorder | pipeline', (group) => {
  group.each.teardown(() => {
    setInternalLogger(null)
  })

  test('drop entries past the per-type cap and count them as truncated', ({ assert }) => {
    const recorder = new Recorder({
      config: makeConfig({ caps: { query: 200 } }),
      store: new FakeStore(),
    })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      for (let index = 0; index < 201; index++) {
        recorder.record(IncomingEntry.make(EntryType.QUERY, { index }))
      }
    })

    assert.lengthOf(context.buffer, 200)
    assert.equal(context.counters.query, 200)
    assert.equal(context.truncated.query, 1)

    /**
     * It is the 201st entry that was dropped, not an arbitrary one: the buffer still ends with
     * the 200th.
     */
    assert.equal(context.buffer[199].content.index, 199)
  })

  test('charge caps per type rather than per batch', ({ assert }) => {
    const recorder = new Recorder({
      config: makeConfig({ caps: { query: 1 } }),
      store: new FakeStore(),
    })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY))
      recorder.record(IncomingEntry.make(EntryType.QUERY))
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    assert.lengthOf(context.buffer, 2)
    assert.deepEqual(context.truncated, { query: 1 })
  })

  test('redact secrets before the entry reaches the buffer', ({ assert }) => {
    const recorder = new Recorder({ config: makeConfig(), store: new FakeStore() })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(
        IncomingEntry.make(EntryType.LOG, { password: 'x', nested: { api_key: 'y' } })
      )
    })

    const content = context.buffer[0].content

    assert.equal(content.password, '[REDACTED]')
    assert.deepEqual(content.nested, { api_key: '[REDACTED]' })
  })

  test('run filter hooks before redaction and tag hooks after it', ({ assert }) => {
    const seenByFilter: unknown[] = []
    const seenByTag: unknown[] = []

    const recorder = new Recorder({
      config: makeConfig({
        filter: [
          (entry) => {
            seenByFilter.push(entry.content.password)
            return true
          },
        ],
        tag: [
          (entry) => {
            seenByTag.push(entry.content.password)
            return ['inspected']
          },
        ],
      }),
      store: new FakeStore(),
    })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG, { password: 'hunter2' }))
    })

    assert.deepEqual(seenByFilter, ['hunter2'])
    assert.deepEqual(seenByTag, ['[REDACTED]'])
    assert.deepEqual(context.buffer[0].tags, ['inspected'])
  })

  test('drop an entry vetoed by a filter hook', ({ assert }) => {
    const recorder = new Recorder({
      config: makeConfig({ filter: [(entry) => entry.type !== EntryType.QUERY] }),
      store: new FakeStore(),
    })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY))
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].type, EntryType.LOG)

    /**
     * A vetoed entry must not eat a cap slot — caps are charged after the filters.
     */
    assert.isUndefined(context.counters.query)
    assert.deepEqual(context.truncated, {})
  })

  test('append the tags returned by a tag hook', ({ assert }) => {
    const recorder = new Recorder({
      config: makeConfig({ tag: [() => ['slow', 'audited']] }),
      store: new FakeStore(),
    })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY).withTags('connection:pg'))
    })

    assert.deepEqual(context.buffer[0].tags, ['connection:pg', 'slow', 'audited'])
  })

  test('run configured hooks before runtime-registered ones', ({ assert }) => {
    const order: string[] = []
    const recorder = new Recorder({
      config: makeConfig({
        filter: [
          () => {
            order.push('config')
            return true
          },
        ],
      }),
      store: new FakeStore(),
    })

    recorder.filter(() => {
      order.push('runtime')
      return true
    })

    BatchScope.runWith(BatchScope.createContext('request'), () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    assert.deepEqual(order, ['config', 'runtime'])
  })

  test('drop everything recorded into a muted context', ({ assert }) => {
    const recorder = new Recorder({ config: makeConfig(), store: new FakeStore() })
    const context = BatchScope.createContext('request')
    context.muted = true

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    assert.lengthOf(context.buffer, 0)
    assert.deepEqual(context.counters, {})
  })

  test('drop everything while the recorder is disabled', ({ assert }) => {
    const recorder = new Recorder({
      config: makeConfig({ enabled: true }),
      store: new FakeStore(),
      enabled: false,
    })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    assert.isFalse(recorder.enabled)
    assert.lengthOf(context.buffer, 0)
  })

  test('fall back to config.enabled when the option is omitted', ({ assert }) => {
    const store = new FakeStore()

    assert.isFalse(new Recorder({ config: makeConfig({ enabled: false }), store }).enabled)
    assert.isTrue(new Recorder({ config: makeConfig({ enabled: true }), store }).enabled)
  })

  test('stamp entries with the active batch id and increasing sequences', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
      recorder.record(IncomingEntry.make(EntryType.LOG))
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    for (const entry of context.buffer) {
      assert.equal(entry.batchId, context.batchId)
    }

    /**
     * Read back through `toStored()`, which is where `sequence` stops being nullable — an
     * unstamped entry cannot get this far, and `toStored()` throws if one ever does.
     */
    await recorder.flush(context)

    const [first, second, third] = store.saves[0]

    assert.equal(first.batchId, context.batchId)
    assert.isTrue(second.sequence > first.sequence)
    assert.isTrue(third.sequence > second.sequence)
  })

  test('record into the ambient batch when there is no active scope', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })

    recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'ambient' }))

    await recorder.flush()

    assert.lengthOf(store.saves, 1)
    assert.equal(store.saves[0][0].content.message, 'ambient')
  })
})

test.group('Recorder | resilience', (group) => {
  group.each.teardown(() => {
    setInternalLogger(null)
  })

  test('record an entry despite a throwing filter hook and a throwing tag hook', ({ assert }) => {
    const labels: string[] = []
    setInternalLogger((label) => labels.push(label))

    const recorder = new Recorder({
      config: makeConfig({
        filter: [
          () => {
            throw new Error('broken filter')
          },
        ],
        tag: [
          () => {
            throw new Error('broken tag')
          },
        ],
      }),
      store: new FakeStore(),
    })

    recorder.filter(() => {
      throw new Error('broken runtime filter')
    })
    recorder.tag(() => {
      throw new Error('broken runtime tag')
    })

    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'survives' }))
    })

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].content.message, 'survives')
    assert.deepEqual(context.buffer[0].tags, [])
    assert.deepEqual(labels, [
      'periscope.recorder.filter',
      'periscope.recorder.filter',
      'periscope.recorder.tag',
      'periscope.recorder.tag',
    ])
  })

  test('never throw when handed a hostile entry', ({ assert }) => {
    const recorder = new Recorder({ config: makeConfig(), store: new FakeStore() })

    const hostile = {
      type: EntryType.LOG,
      get content(): EntryContent {
        throw new Error('exploding content')
      },
    } as unknown as IncomingEntry

    const context = BatchScope.createContext('request')

    assert.doesNotThrow(() => {
      BatchScope.runWith(context, () => recorder.record(hostile))
    })

    assert.lengthOf(context.buffer, 0)
  })

  test('resolve instead of rejecting when the store write fails', async ({ assert }) => {
    const store = new FakeStore()
    store.saveFailure = new Error('the database is on fire')

    const recorder = new Recorder({ config: makeConfig(), store })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    /**
     * A rejection here fails the test: the request middleware awaits `flush()` on the way out of
     * every request, so a broken store must never become a 500.
     */
    await recorder.flush(context)

    assert.lengthOf(store.saves, 0)
    assert.lengthOf(context.buffer, 0, 'a failed write must not leave the buffer to grow forever')
  })
})

test.group('Recorder | flush', (group) => {
  group.each.teardown(() => {
    setInternalLogger(null)
  })

  test('write the drained buffer to the store as stored entries', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY, { sql: 'select 1' }))
      recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'hello' }))
    })

    await recorder.flush(context)

    assert.lengthOf(context.buffer, 0)
    assert.lengthOf(store.saves, 1)
    assert.lengthOf(store.saves[0], 2)

    const [first] = store.saves[0]

    assert.equal(first.type, EntryType.QUERY)
    assert.equal(first.batchId, context.batchId)
    assert.deepEqual(first.content, { sql: 'select 1' })
    assert.isTrue(first.shouldDisplayOnIndex)
    assert.equal(typeof first.sequence, 'bigint')
  })

  test('default to the active batch when no target is given', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })
    const context = BatchScope.createContext('request')

    await BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
      return recorder.flush()
    })

    assert.lengthOf(store.saves, 1)
    assert.equal(store.saves[0][0].batchId, context.batchId)
  })

  test('never touch the store when nothing was buffered', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })

    await recorder.flush(BatchScope.createContext('request'))

    assert.lengthOf(store.saves, 0)
  })

  test('report truncation on the request entry of a request batch', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig({ caps: { query: 1 } }), store })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY, { sql: 'select 1' }))
      recorder.record(IncomingEntry.make(EntryType.QUERY, { sql: 'select 2' }))
      recorder.record(IncomingEntry.make(EntryType.REQUEST, { method: 'GET' }))
    })

    await recorder.flush(context)

    const [query, request] = store.saves[0]

    assert.equal(query.type, EntryType.QUERY)
    assert.equal(request.type, EntryType.REQUEST)

    assert.deepEqual(request.content.truncated, { query: 1 })
    assert.include(request.tags, 'truncated')

    assert.isUndefined(query.content.truncated)
    assert.notInclude(query.tags, 'truncated')
  })

  test('report truncation on the job entry of a queue batch', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig({ caps: { query: 1 } }), store })
    const context = BatchScope.createContext('queue')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY))
      recorder.record(IncomingEntry.make(EntryType.QUERY))
      recorder.record(IncomingEntry.make(EntryType.JOB, { name: 'SendWelcomeEmail' }))
    })

    await recorder.flush(context)

    const [query, job] = store.saves[0]

    assert.equal(job.type, EntryType.JOB)
    assert.deepEqual(job.content.truncated, { query: 1 })
    assert.isUndefined(query.content.truncated)
  })

  test('report truncation on the first entry of a batch with no primary type', async ({
    assert,
  }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig({ caps: { query: 1 } }), store })
    const context = BatchScope.createContext('ambient')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY))
      recorder.record(IncomingEntry.make(EntryType.QUERY))
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    await recorder.flush(context)

    const [query, log] = store.saves[0]

    assert.deepEqual(query.content.truncated, { query: 1 })
    assert.isUndefined(log.content.truncated)
  })

  test('report truncation once, and keep caps charged across flushes', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig({ caps: { query: 1 } }), store })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY))
      recorder.record(IncomingEntry.make(EntryType.QUERY))
    })

    await recorder.flush(context)

    assert.deepEqual(context.truncated, {}, 'reported counts must be cleared')
    assert.equal(context.counters.query, 1, 'caps are per batch, so a flush must not reset them')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    await recorder.flush(context)

    assert.lengthOf(store.saves[1], 1)
    assert.equal(store.saves[1][0].type, EntryType.LOG)
    assert.isUndefined(
      store.saves[1][0].content.truncated,
      'a second flush must not re-report drops it already reported'
    )

    /**
     * The cap itself survived both flushes: a query recorded now is still over the limit, and
     * its drop is counted afresh rather than being forgiven by the flush.
     */
    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY))
    })

    assert.deepEqual(context.truncated, { query: 1 })
  })

  test('mute recording while the store writes so the driver cannot record itself', async ({
    assert,
  }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })
    const context = BatchScope.createContext('request')

    let mutedDuringSave: boolean | undefined
    let bufferedDuringSave: number | undefined

    store.onSave = () => {
      const inner = BatchScope.current()

      /**
       * Exactly what a Lucid-backed driver does implicitly: run a query, which the query watcher
       * would hand straight back to the recorder (§0, invariant 2).
       */
      recorder.record(IncomingEntry.make(EntryType.QUERY, { sql: 'insert into periscope' }))

      mutedDuringSave = inner?.muted
      bufferedDuringSave = inner?.buffer.length
    }

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    await recorder.flush(context)

    assert.isTrue(mutedDuringSave, 'the store must be called inside a muted context')
    assert.equal(bufferedDuringSave, 0, 'the query issued by the store must not be buffered')
    assert.lengthOf(context.buffer, 0)
    assert.lengthOf(store.saves, 1, 'the write must not have triggered another write')
  })

  test('flush the ambient batch on shutdown and tolerate a second call', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })

    recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'outside any batch' }))

    await recorder.shutdown()
    await recorder.shutdown()

    assert.lengthOf(store.saves, 1)
    assert.equal(store.saves[0][0].content.message, 'outside any batch')
  })

  test('report the drop when a cap of zero left the flush with nothing to write', async ({
    assert,
  }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig({ caps: { log: 0 } }), store })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'never recorded' }))
      recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'nor this one' }))
    })

    assert.lengthOf(context.buffer, 0, 'a cap of 0 means "record none of this type"')
    assert.deepEqual(context.truncated, { log: 2 })

    await recorder.flush(context)

    /**
     * There is no entry to fold the note into — every entry of the batch was capped away — so the
     * recorder mints one. Returning early on an empty buffer used to lose the report entirely.
     */
    assert.lengthOf(store.saves, 1)
    assert.lengthOf(store.saves[0], 1)

    const [note] = store.saves[0]

    assert.equal(note.batchId, context.batchId)
    assert.deepEqual(note.content.truncated, { log: 2 })
    assert.include(note.tags, 'truncated')
    assert.isFalse(note.shouldDisplayOnIndex, 'the note belongs to a batch, not to an index screen')
    assert.deepEqual(context.truncated, {}, 'a reported count must never be reported twice')
  })

  test('report drops accrued after the batch already flushed its entries', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig({ caps: { query: 1 } }), store })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY, { sql: 'select 1' }))
    })

    await recorder.flush(context)

    assert.isUndefined(store.saves[0][0].content.truncated, 'nothing was dropped yet')

    /**
     * The batch stays open past its first flush — a middleware flushing early, a long-lived queue
     * batch — and keeps hitting the cap. The second flush drains an empty buffer, which used to
     * return before the counts were ever read, so they accumulated on the context forever.
     */
    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY, { sql: 'select 2' }))
    })

    await recorder.flush(context)

    assert.lengthOf(store.saves, 2)
    assert.deepEqual(store.saves[1][0].content.truncated, { query: 1 })
    assert.deepEqual(context.truncated, {})
  })

  test('attach the truncation note without mutating the object the watcher handed over', async ({
    assert,
  }) => {
    const store = new FakeStore()
    const recorder = new Recorder({
      config: makeConfig({ caps: { query: 1 }, redactKeys: [] }),
      store,
    })
    const context = BatchScope.createContext('request')

    /**
     * With no keys configured, redaction is a pass-through that returns its argument by identity,
     * so this object — owned by the host application and still referenced here — is the one the
     * entry carries. Periscope may read it; it may not write to it.
     */
    const hostContent: EntryContent = { method: 'GET', url: '/checkout' }

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.QUERY))
      recorder.record(IncomingEntry.make(EntryType.QUERY))
      recorder.record(IncomingEntry.make(EntryType.REQUEST, hostContent))
    })

    assert.strictEqual(
      context.buffer[1].content,
      hostContent,
      'the premise of this test: nothing copied the content on the way in'
    )

    await recorder.flush(context)

    assert.deepEqual(hostContent, { method: 'GET', url: '/checkout' })

    const [, request] = store.saves[0]

    assert.deepEqual(request.content, {
      method: 'GET',
      url: '/checkout',
      truncated: { query: 1 },
    })
  })
})

test.group('Recorder | opportunistic trim', (group) => {
  group.each.teardown(() => {
    setInternalLogger(null)
  })

  test('leave the store alone until the flush interval is reached', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })

    await flushBatches(recorder, TRIM_EVERY_FLUSHES - 1)

    assert.lengthOf(store.saves, TRIM_EVERY_FLUSHES - 1)
    assert.lengthOf(store.trims, 0, 'trimming on every flush is exactly what the interval avoids')
  })

  test('trim once at the interval, with the configured cap', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })

    await flushBatches(recorder, TRIM_EVERY_FLUSHES)

    assert.deepEqual(store.trims, [10_000], 'the cap comes from storage.maxEntries, unmodified')
  })

  test('restart the interval after a trim instead of trimming on every later flush', async ({
    assert,
  }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })

    await flushBatches(recorder, TRIM_EVERY_FLUSHES * 2)

    assert.lengthOf(store.trims, 2)
  })

  test('not advance the interval on a flush that wrote nothing', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })

    /**
     * An idle application still flushes: the ambient batch rotates on a timer whether or not
     * anything was recorded, and the request middleware flushes every request. Letting those
     * empty flushes count would turn "every 25 writes" into "every 25 ticks", trimming a store
     * nothing has been added to since the last trim.
     */
    for (let index = 0; index < TRIM_EVERY_FLUSHES; index++) {
      await recorder.flush(BatchScope.createContext('request'))
    }

    assert.lengthOf(store.saves, 0)
    assert.lengthOf(store.trims, 0)

    await flushBatches(recorder, TRIM_EVERY_FLUSHES)

    assert.lengthOf(store.trims, 1, 'the interval counts writes, not calls')
  })

  test('mute recording while the store trims so the delete cannot record itself', async ({
    assert,
  }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })

    let mutedDuringTrim: boolean | undefined
    let bufferedDuringTrim: number | undefined

    store.onTrim = () => {
      const inner = BatchScope.current()

      /**
       * A trim is a `delete from periscope_entries`, which the query watcher observes exactly
       * like the insert the save just did (§0, invariant 2). Unmuted, housekeeping would write
       * the entries that make the next housekeeping necessary.
       */
      recorder.record(IncomingEntry.make(EntryType.QUERY, { sql: 'delete from periscope' }))

      mutedDuringTrim = inner?.muted
      bufferedDuringTrim = inner?.buffer.length
    }

    await flushBatches(recorder, TRIM_EVERY_FLUSHES)

    assert.lengthOf(store.trims, 1)
    assert.isTrue(mutedDuringTrim, 'the trim must be called inside a muted context')
    assert.equal(bufferedDuringTrim, 0, 'the delete issued by the store must not be buffered')
  })

  test('resolve the flush and keep its entries when the trim fails', async ({ assert }) => {
    const store = new FakeStore()
    store.trimFailure = new Error('cannot delete from a read-only replica')

    const recorder = new Recorder({ config: makeConfig(), store })

    /**
     * A rejection here fails the test for the same reason a failing save must not reject: the
     * request middleware awaits this flush, and housekeeping is not allowed to become a 500.
     */
    await flushBatches(recorder, TRIM_EVERY_FLUSHES)

    assert.lengthOf(store.saves, TRIM_EVERY_FLUSHES, 'the write of the trimming flush must stand')
    assert.lengthOf(store.trims, 0, 'the double refused the trim')
  })

  test('wait a full interval before retrying a trim that failed', async ({ assert }) => {
    const store = new FakeStore()
    store.trimFailure = new Error('the database is locked')

    const recorder = new Recorder({ config: makeConfig(), store })

    await flushBatches(recorder, TRIM_EVERY_FLUSHES)

    store.trimFailure = null

    /**
     * The counter is reset before the attempt, not after a success, so a broken store is retried
     * on the next interval rather than on every single flush until it recovers.
     */
    await flushBatches(recorder, TRIM_EVERY_FLUSHES - 1)

    assert.lengthOf(store.trims, 0)

    await flushBatches(recorder, 1)

    assert.deepEqual(store.trims, [10_000])
  })
})

test.group('Recorder | pause flag', (group) => {
  group.each.teardown(() => {
    setInternalLogger(null)
  })

  test('drop entries once the cached pause flag has been refreshed', async ({ assert }) => {
    const store = new FakeStore()
    await store.setFlag(Flag.PAUSED, '1')

    const recorder = new Recorder({ config: makeConfig(), store })
    const context = BatchScope.createContext('request')

    /**
     * The first read is answered from the cold cache — the point of the design is that nothing
     * on the hot path awaits the store — and kicks off the refresh.
     */
    assert.isFalse(recorder.paused)

    await tick()

    assert.isTrue(recorder.paused)

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    assert.lengthOf(context.buffer, 0)
  })

  test('read the flag at most once per ttl window', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig({ pausedFlagTtlMs: 5_000 }), store })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      for (let index = 0; index < 50; index++) {
        recorder.record(IncomingEntry.make(EntryType.LOG))
      }
    })

    await tick()

    assert.equal(store.getFlagCalls, 1)
    assert.lengthOf(context.buffer, 50)
  })

  test('keep the last known value when the store fails to answer', async ({ assert }) => {
    const store = new FakeStore()
    await store.setFlag(Flag.PAUSED, '1')

    const recorder = new Recorder({ config: makeConfig({ pausedFlagTtlMs: 0 }), store })

    assert.isFalse(recorder.paused, 'the first read is answered from the cold cache')

    await tick()

    assert.isTrue(recorder.paused)

    store.getFlagFailure = new Error('the flag store is unreachable')

    assert.isTrue(recorder.paused, 'this read kicks off the refresh that will fail')

    await tick()

    assert.isTrue(recorder.paused, 'an unreachable store must not silently flip recording back on')
  })

  test('read the flag inside a muted context', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig(), store })
    const context = BatchScope.createContext('request')

    let mutedDuringRead: boolean | undefined
    let batchDuringRead: string | undefined

    store.onGetFlag = () => {
      mutedDuringRead = BatchScope.current()?.muted
      batchDuringRead = BatchScope.current()?.batchId
    }

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    await tick()

    assert.equal(store.getFlagCalls, 1)

    /**
     * §0, invariant 2 covers every store call, not just `save()`. The refresh is kicked off from
     * inside `record()`, so an unmuted read would hand the driver's own query and log traffic
     * straight back to the recorder — and attribute it to whichever host batch tripped the TTL.
     */
    assert.isTrue(mutedDuringRead, 'the flag read must happen inside a muted context')
    assert.equal(batchDuringRead, context.batchId, 'muting keeps the batch it was opened under')
  })

  test('refresh the flag after the wall clock steps backwards', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig({ pausedFlagTtlMs: 5 }), store })
    const realDateNow = Date.now

    try {
      assert.isFalse(recorder.paused, 'the first read is answered from the cold cache')

      await tick()

      assert.equal(store.getFlagCalls, 1)

      /**
       * An NTP correction, or a container resuming with a synchronised clock: the wall clock
       * steps an hour into the past. A TTL measured against it goes negative and stays negative
       * for that whole hour, freezing the cached flag — which is why the TTL is measured with
       * `performance.now()` instead.
       */
      Date.now = () => realDateNow() - 3_600_000

      await sleep(20)

      assert.isFalse(recorder.paused)

      await tick()

      assert.equal(store.getFlagCalls, 2, 'the ttl must not be measured against the wall clock')
    } finally {
      Date.now = realDateNow
    }
  })
})

test.group('Recorder | hook registration', () => {
  test('stop running a filter hook once it is unregistered', ({ assert }) => {
    const recorder = new Recorder({ config: makeConfig(), store: new FakeStore() })
    const context = BatchScope.createContext('request')

    const unregister = recorder.filter(() => false)

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    assert.lengthOf(context.buffer, 0)

    unregister()

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    assert.lengthOf(context.buffer, 1)
  })

  test('remove only its own registration when unregistering twice', ({ assert }) => {
    const recorder = new Recorder({ config: makeConfig(), store: new FakeStore() })
    const context = BatchScope.createContext('request')
    const calls: string[] = []

    const unregisterFirst = recorder.filter(() => {
      calls.push('first')
      return true
    })
    recorder.filter(() => {
      calls.push('second')
      return true
    })

    unregisterFirst()
    unregisterFirst()

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    assert.deepEqual(calls, ['second'])
    assert.lengthOf(context.buffer, 1)
  })

  test('stop running a tag hook once it is unregistered', ({ assert }) => {
    const recorder = new Recorder({ config: makeConfig(), store: new FakeStore() })
    const context = BatchScope.createContext('request')

    const unregister = recorder.tag(() => ['runtime'])

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    unregister()
    unregister()

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.LOG))
    })

    assert.deepEqual(context.buffer[0].tags, ['runtime'])
    assert.deepEqual(context.buffer[1].tags, [])
  })

  test('run the callback of mute inside a muted context', ({ assert }) => {
    const recorder = new Recorder({ config: makeConfig(), store: new FakeStore() })

    assert.isTrue(recorder.mute(() => BatchScope.current()?.muted === true))
  })
})

test.group('Recorder | lifecycle', (group) => {
  group.each.teardown(() => {
    setInternalLogger(null)
  })

  test('drain the ambient batch through the rotation timer once started', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig({ ambientRotationMs: 10 }), store })

    recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'rotated' }))

    assert.lengthOf(store.saves, 0, 'nothing reaches the store until a rotation retires the batch')

    recorder.start()

    await waitUntil(() => store.saves.length > 0)

    assert.lengthOf(store.saves, 1)
    assert.equal(store.saves[0][0].content.message, 'rotated')

    await recorder.shutdown()

    /**
     * The rotation timer is `unref`ed, so it is invisible to `process.getActiveResourcesInfo()`;
     * the only honest way to see whether it is still armed is to leave it something to rotate.
     * Several windows pass without a write, and the manual flush then proves the entry really was
     * sitting in the buffer rather than never having been recorded.
     */
    recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'after shutdown' }))

    await waitUntil(() => store.saves.length > 1, 60)

    assert.lengthOf(store.saves, 1, 'shutdown must disarm the rotation timer')

    await recorder.flush()

    assert.lengthOf(store.saves, 2)
    assert.equal(store.saves[1][0].content.message, 'after shutdown')
  })

  test('shut down a second time after being restarted', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({ config: makeConfig({ ambientRotationMs: 10_000 }), store })

    recorder.start()
    recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'first run' }))

    await recorder.shutdown()

    assert.lengthOf(store.saves, 1)

    recorder.start()
    recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'second run' }))

    /**
     * The rotation window is far longer than this test, so the final flush can only come from
     * `shutdown()`. A memo that survived the restart would answer this call with the *first*
     * shutdown, leaving the entry unwritten and the timer armed above still rotating.
     */
    await recorder.shutdown()

    assert.lengthOf(store.saves, 2)
    assert.equal(store.saves[1][0].content.message, 'second run')
  })

  test('arm nothing when a disabled recorder is started', async ({ assert }) => {
    const store = new FakeStore()
    const recorder = new Recorder({
      config: makeConfig({ ambientRotationMs: 5 }),
      store,
      enabled: false,
    })

    recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'ignored' }))
    recorder.start()

    await waitUntil(() => store.saves.length > 0, 60)

    assert.lengthOf(store.saves, 0, 'a disabled recorder neither buffers nor rotates')

    await recorder.shutdown()

    assert.lengthOf(store.saves, 0)
  })
})
