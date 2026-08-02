/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'

import { IncomingEntry } from '../../src/entry.ts'
import { ENTRY_TYPES, EntryType, WATCHER_NAMES } from '../../src/types.ts'
import type {
  BatchContext,
  BatchKind,
  EntryContent,
  EntryQuery,
  ExceptionGroup,
  ExceptionGroupQuery,
  EntryTypeCounts,
  FilterHook,
  FlagOptions,
  Paginated,
  PeriscopeConfig,
  PeriscopeStore,
  PeriscopeStoreFactory,
  PruneOptions,
  ResolvedPeriscopeConfig,
  ResolvedWatchersConfig,
  StorageDriverName,
  StoredEntry,
  TagHook,
  WatchersConfig,
  WatcherName,
} from '../../src/types.ts'

/**
 * These are compile-time assertions first and foremost: the whole point of `src/types.ts` is that
 * storage drivers, watchers, the recorder and the dashboard all code against one shape, so a
 * silent rename or a widened field has to break the build rather than a screen in production.
 *
 * Every test still pins a matching *runtime* fact about the same subject. A file of pure
 * `expectTypeOf` calls passes trivially at runtime, which makes it easy to delete a whole test by
 * accident and never notice; the runtime half keeps each test honest and gives the type half
 * something concrete to describe.
 */

/**
 * A store double built to the interface. It is the runtime counterpart of the `PeriscopeStore`
 * type assertions: excess property checks reject a method the interface dropped, and the missing
 * property error catches one it gained, so the object cannot drift from the contract.
 */
const storeDouble: PeriscopeStore = {
  save: async () => {},
  find: async () => null,
  list: async () => ({ data: [], nextCursor: null }),
  batch: async () => [],
  counts: async () => ({}),
  requestStats: async () => ({ buckets: [], sampled: 0, truncated: false }),
  applications: async () => [],
  exceptionGroups: async () => ({ data: [], nextCursor: null }),
  prune: async () => 0,
  trim: async () => 0,
  clear: async () => {},
  monitoredTags: async () => [],
  monitorTag: async () => {},
  unmonitorTag: async () => {},
  getFlag: async () => null,
  hasFlagWithPrefix: async () => false,
  setFlag: async () => {},
  deleteFlag: async () => {},
  close: async () => {},
}

/**
 * A fully populated entry, used as the runtime witness that the literal shape a driver has to
 * produce is exactly the shape `StoredEntry` describes.
 */
const storedEntry: StoredEntry = {
  uuid: '5c9f9f3a-2b5e-4c1f-8f3a-1b2c3d4e5f60',
  batchId: 'batch-1',
  application: 'default',
  type: EntryType.QUERY,
  familyHash: 'family-1',
  content: { sql: 'select 1' },
  tags: ['connection:pg'],
  shouldDisplayOnIndex: true,
  sequence: 1_700_000_000_000_000_000n,
  createdAt: new Date('2026-07-25T10:00:00.000Z'),
}

test.group('Types | EntryType', () => {
  test('cover every member of the const object with ENTRY_TYPES', ({ assert, expectTypeOf }) => {
    assert.deepEqual(new Set(ENTRY_TYPES), new Set(Object.values(EntryType)))
    assert.lengthOf(ENTRY_TYPES, Object.keys(EntryType).length)

    expectTypeOf<(typeof ENTRY_TYPES)[number]>().toEqualTypeOf<EntryType>()
    expectTypeOf<EntryType>().toEqualTypeOf<(typeof EntryType)[keyof typeof EntryType]>()
  })

  test('expose the catalogue as literal string values', ({ assert, expectTypeOf }) => {
    assert.equal(EntryType.HTTP_CLIENT, 'http_client')
    assert.equal(EntryType.HEALTH_CHECK, 'health_check')
    assert.equal(EntryType.QUERY, 'query')

    expectTypeOf(EntryType.HTTP_CLIENT).toEqualTypeOf<'http_client'>()
    expectTypeOf(EntryType.HEALTH_CHECK).toEqualTypeOf<'health_check'>()
    expectTypeOf<EntryType>().toExtend<string>()
  })
})

test.group('Types | WatcherName', () => {
  test('append every shipped watcher in registration order', ({ assert, expectTypeOf }) => {
    assert.deepEqual(WATCHER_NAMES, [
      'request',
      'query',
      'exception',
      'log',
      'event',
      'command',
      'mail',
      'cache',
      'model',
      'gate',
      'dump',
      'view',
      'http_client',
      'job_schedule',
      'health_check',
      'transmit',
      'redis',
      'session',
    ])

    expectTypeOf<(typeof WATCHER_NAMES)[number]>().toEqualTypeOf<WatcherName>()
    expectTypeOf<keyof WatchersConfig>().toEqualTypeOf<WatcherName | 'custom'>()
    expectTypeOf<keyof ResolvedWatchersConfig>().toEqualTypeOf<WatcherName | 'custom'>()
  })
})

test.group('Types | StoredEntry', () => {
  test('type every persisted field the way drivers and the dashboard read it', ({
    assert,
    expectTypeOf,
  }) => {
    assert.equal(typeof storedEntry.sequence, 'bigint')
    assert.instanceOf(storedEntry.createdAt, Date)
    assert.isArray(storedEntry.tags)

    expectTypeOf<StoredEntry['uuid']>().toBeString()
    expectTypeOf<StoredEntry['batchId']>().toBeString()
    expectTypeOf<StoredEntry['type']>().toEqualTypeOf<EntryType>()
    expectTypeOf<StoredEntry['familyHash']>().toEqualTypeOf<string | null>()
    expectTypeOf<StoredEntry['content']>().toEqualTypeOf<EntryContent>()
    expectTypeOf<StoredEntry['tags']>().toEqualTypeOf<string[]>()
    expectTypeOf<StoredEntry['shouldDisplayOnIndex']>().toBeBoolean()

    /**
     * Nanosecond ordering stamp. Narrowing it to `number` would silently lose precision and
     * break cursor pagination, so it is pinned rather than merely "numeric".
     */
    expectTypeOf<StoredEntry['sequence']>().toEqualTypeOf<bigint>()
    expectTypeOf<StoredEntry['createdAt']>().toEqualTypeOf<Date>()
  })

  test('keep the key set closed and every field required', ({ assert, expectTypeOf }) => {
    assert.deepEqual(Object.keys(storedEntry).sort(), [
      'application',
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

    expectTypeOf<keyof StoredEntry>().toEqualTypeOf<
      | 'uuid'
      | 'batchId'
      | 'application'
      | 'type'
      | 'familyHash'
      | 'content'
      | 'tags'
      | 'shouldDisplayOnIndex'
      | 'sequence'
      | 'createdAt'
    >()
    expectTypeOf<Required<StoredEntry>>().toEqualTypeOf<StoredEntry>()
    expectTypeOf<EntryContent>().toEqualTypeOf<Record<string, unknown>>()
  })
})

test.group('Types | Paginated', () => {
  test('carry a page of rows plus a nullable cursor', ({ assert, expectTypeOf }) => {
    const lastPage: Paginated<StoredEntry> = { data: [storedEntry], nextCursor: null }
    const morePages: Paginated<StoredEntry> = { data: [storedEntry], nextCursor: 'cursor-1' }

    assert.isNull(lastPage.nextCursor)
    assert.equal(morePages.nextCursor, 'cursor-1')
    assert.lengthOf(lastPage.data, 1)

    expectTypeOf<Paginated<StoredEntry>['data']>().toEqualTypeOf<StoredEntry[]>()
    expectTypeOf<Paginated<StoredEntry>['nextCursor']>().toEqualTypeOf<string | null>()
    expectTypeOf<keyof Paginated<StoredEntry>>().toEqualTypeOf<'data' | 'nextCursor'>()
  })
})

test.group('Types | EntryQuery', () => {
  test('make every filter optional so they combine freely', ({ assert, expectTypeOf }) => {
    const unfiltered: EntryQuery = {}
    const filtered: EntryQuery = {
      type: EntryType.QUERY,
      tag: 'status:500',
      tags: ['slow', 'failed'],
      text: 'timeout',
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-02T00:00:00.000Z',
      familyHash: 'family-1',
      batchId: 'batch-1',
      application: 'default',
      displayOnIndex: true,
      level: 'error',
      sort: 'sequence',
      direction: 'asc',
      cursor: 'cursor-1',
      limit: 25,
    }

    assert.deepEqual(Object.keys(unfiltered), [])
    assert.lengthOf(Object.keys(filtered), 15)

    expectTypeOf<Partial<EntryQuery>>().toEqualTypeOf<EntryQuery>()
    expectTypeOf<keyof EntryQuery>().toEqualTypeOf<
      | 'type'
      | 'tag'
      | 'tags'
      | 'text'
      | 'from'
      | 'to'
      | 'familyHash'
      | 'batchId'
      | 'application'
      | 'displayOnIndex'
      | 'level'
      | 'sort'
      | 'direction'
      | 'cursor'
      | 'limit'
    >()

    /**
     * The cursor is an opaque string even though it is derived from a `bigint` sequence — a
     * driver handing back a `bigint` would not survive the JSON API.
     */
    expectTypeOf<Required<EntryQuery>['cursor']>().toEqualTypeOf<string>()
    expectTypeOf<Required<EntryQuery>['type']>().toEqualTypeOf<EntryType>()
    expectTypeOf<Required<EntryQuery>['limit']>().toEqualTypeOf<number>()
    expectTypeOf<Required<EntryQuery>['displayOnIndex']>().toBeBoolean()
    expectTypeOf<Required<EntryQuery>['tags']>().toEqualTypeOf<string[]>()
    expectTypeOf<Required<EntryQuery>['text']>().toEqualTypeOf<string>()
    expectTypeOf<Required<EntryQuery>['from']>().toEqualTypeOf<string>()
    expectTypeOf<Required<EntryQuery>['to']>().toEqualTypeOf<string>()
    expectTypeOf<Required<EntryQuery>['level']>().toEqualTypeOf<string>()
    expectTypeOf<Required<EntryQuery>['sort']>().toEqualTypeOf<'sequence'>()
    expectTypeOf<Required<EntryQuery>['direction']>().toEqualTypeOf<'asc' | 'desc'>()
  })
})

test.group('Types | PeriscopeStore', () => {
  test('expose exactly the methods every driver implements', ({ assert, expectTypeOf }) => {
    assert.deepEqual(Object.keys(storeDouble).sort(), [
      'applications',
      'batch',
      'clear',
      'close',
      'counts',
      'deleteFlag',
      'exceptionGroups',
      'find',
      'getFlag',
      'hasFlagWithPrefix',
      'list',
      'monitorTag',
      'monitoredTags',
      'prune',
      'requestStats',
      'save',
      'setFlag',
      'trim',
      'unmonitorTag',
    ])

    expectTypeOf<keyof PeriscopeStore>().toEqualTypeOf<
      | 'save'
      | 'find'
      | 'list'
      | 'batch'
      | 'counts'
      | 'requestStats'
      | 'applications'
      | 'exceptionGroups'
      | 'prune'
      | 'trim'
      | 'clear'
      | 'monitoredTags'
      | 'monitorTag'
      | 'unmonitorTag'
      | 'getFlag'
      | 'hasFlagWithPrefix'
      | 'setFlag'
      | 'deleteFlag'
      | 'close'
    >()
  })

  test('pin the read and write signatures for entries', async ({ assert, expectTypeOf }) => {
    assert.isNull(await storeDouble.find('unknown'))
    assert.deepEqual(await storeDouble.list(), { data: [], nextCursor: null })
    assert.deepEqual(await storeDouble.batch('batch-1'), [])
    assert.deepEqual(await storeDouble.counts(), {})
    assert.deepEqual(await storeDouble.exceptionGroups(), { data: [], nextCursor: null })

    expectTypeOf<PeriscopeStore['save']>().toEqualTypeOf<
      (entries: StoredEntry[]) => Promise<void>
    >()
    expectTypeOf<PeriscopeStore['find']>().toEqualTypeOf<
      (uuid: string) => Promise<StoredEntry | null>
    >()
    expectTypeOf<PeriscopeStore['list']>().toEqualTypeOf<
      (query?: EntryQuery) => Promise<Paginated<StoredEntry>>
    >()
    expectTypeOf<PeriscopeStore['batch']>().toEqualTypeOf<
      (batchId: string) => Promise<StoredEntry[]>
    >()
    expectTypeOf<PeriscopeStore['counts']>().toEqualTypeOf<
      (application?: string) => Promise<EntryTypeCounts>
    >()
    expectTypeOf<PeriscopeStore['exceptionGroups']>().toEqualTypeOf<
      (query?: ExceptionGroupQuery) => Promise<Paginated<ExceptionGroup>>
    >()
  })

  test('pin the retention signatures', async ({ assert, expectTypeOf }) => {
    assert.equal(await storeDouble.prune({ before: new Date() }), 0)
    assert.equal(await storeDouble.trim(10), 0)
    assert.isUndefined(await storeDouble.clear())

    expectTypeOf<PeriscopeStore['prune']>().toEqualTypeOf<
      (options: PruneOptions) => Promise<number>
    >()
    expectTypeOf<PeriscopeStore['trim']>().toEqualTypeOf<(maxEntries: number) => Promise<number>>()
    expectTypeOf<PeriscopeStore['clear']>().toEqualTypeOf<(application?: string) => Promise<void>>()
    expectTypeOf<PeriscopeStore['close']>().toEqualTypeOf<() => Promise<void>>()

    expectTypeOf<PruneOptions>().toEqualTypeOf<{
      before: Date
      keepExceptions?: boolean
      application?: string
    }>()
  })

  test('pin the monitored tag and flag signatures', async ({ assert, expectTypeOf }) => {
    assert.deepEqual(await storeDouble.monitoredTags(), [])
    assert.isUndefined(await storeDouble.monitorTag('slow'))
    assert.isUndefined(await storeDouble.unmonitorTag('slow'))
    assert.isNull(await storeDouble.getFlag('paused'))

    expectTypeOf<PeriscopeStore['monitoredTags']>().toEqualTypeOf<() => Promise<string[]>>()
    expectTypeOf<PeriscopeStore['monitorTag']>().toEqualTypeOf<(tag: string) => Promise<void>>()
    expectTypeOf<PeriscopeStore['unmonitorTag']>().toEqualTypeOf<(tag: string) => Promise<void>>()
    expectTypeOf<PeriscopeStore['getFlag']>().toEqualTypeOf<
      (name: string) => Promise<string | null>
    >()
    expectTypeOf<PeriscopeStore['setFlag']>().toEqualTypeOf<
      (name: string, value: string, options?: FlagOptions) => Promise<void>
    >()
    expectTypeOf<PeriscopeStore['deleteFlag']>().toEqualTypeOf<(name: string) => Promise<void>>()

    expectTypeOf<FlagOptions>().toEqualTypeOf<{ expiresAt?: Date }>()
  })
})

test.group('Types | BatchContext', () => {
  test('describe one batch of buffered entries', ({ assert, expectTypeOf }) => {
    const entry = IncomingEntry.make(EntryType.LOG, { message: 'hello' })
    const context: BatchContext = {
      batchId: 'batch-1',
      kind: 'request',
      startedAt: process.hrtime.bigint(),
      sampled: true,
      retention: 'kept',
      buffer: [entry],
      counters: { log: 1 },
      truncated: {},
      muted: false,
    }

    assert.equal(typeof context.startedAt, 'bigint')
    assert.deepEqual(context.buffer, [entry])
    assert.deepEqual(context.counters, { log: 1 })
    assert.isTrue(context.sampled)
    assert.equal(context.retention, 'kept')
    assert.isFalse(context.muted)

    expectTypeOf<keyof BatchContext>().toEqualTypeOf<
      | 'batchId'
      | 'traceId'
      | 'kind'
      | 'startedAt'
      | 'sampled'
      | 'retention'
      | 'buffer'
      | 'counters'
      | 'truncated'
      | 'muted'
    >()
    expectTypeOf<BatchContext['traceId']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<BatchContext['batchId']>().toBeString()
    expectTypeOf<BatchContext['kind']>().toEqualTypeOf<BatchKind>()
    expectTypeOf<BatchContext['startedAt']>().toEqualTypeOf<bigint>()
    expectTypeOf<BatchContext['sampled']>().toBeBoolean()
    expectTypeOf<BatchContext['retention']>().toEqualTypeOf<'pending' | 'kept' | 'dropped'>()
    expectTypeOf<BatchContext['buffer']>().toEqualTypeOf<IncomingEntry[]>()
    expectTypeOf<BatchContext['counters']>().toEqualTypeOf<EntryTypeCounts>()
    expectTypeOf<BatchContext['truncated']>().toEqualTypeOf<EntryTypeCounts>()
    expectTypeOf<BatchContext['muted']>().toBeBoolean()
    expectTypeOf<EntryTypeCounts>().toEqualTypeOf<Partial<Record<EntryType, number>>>()
  })

  test('enumerate every batch kind the recorder can open', ({ assert, expectTypeOf }) => {
    const kinds: BatchKind[] = ['request', 'command', 'queue', 'test', 'ambient']

    assert.lengthOf(kinds, 5)

    expectTypeOf<BatchKind>().toEqualTypeOf<'request' | 'command' | 'queue' | 'test' | 'ambient'>()
  })
})

test.group('Types | hooks', () => {
  test('let a filter hook drop an entry by returning false', ({ assert, expectTypeOf }) => {
    const filter: FilterHook = (entry) => entry.type !== EntryType.QUERY

    assert.isTrue(filter(IncomingEntry.make(EntryType.LOG)))
    assert.isFalse(filter(IncomingEntry.make(EntryType.QUERY)))

    expectTypeOf<FilterHook>().toEqualTypeOf<(entry: IncomingEntry) => boolean>()
    expectTypeOf<FilterHook>().returns.toBeBoolean()
  })

  test('let a tag hook return tags or nothing at all', ({ assert, expectTypeOf }) => {
    const tagging: TagHook = (entry) => [`type:${entry.type}`]
    const silent: TagHook = () => undefined

    assert.deepEqual(tagging(IncomingEntry.make(EntryType.LOG)), ['type:log'])
    assert.isUndefined(silent(IncomingEntry.make(EntryType.LOG)))

    expectTypeOf<TagHook>().parameter(0).toEqualTypeOf<IncomingEntry>()
    expectTypeOf<TagHook>().returns.toEqualTypeOf<string[] | undefined | void>()
  })
})

test.group('Types | configuration', () => {
  test('accept an empty user configuration', ({ assert, expectTypeOf }) => {
    const empty: PeriscopeConfig = {}

    assert.deepEqual(Object.keys(empty), [])

    /**
     * `defineConfig` deep-merges over defaults, so keys may be added without breaking callers.
     * That only holds while *every* key is optional — `Partial<T>` equalling `T` is exactly that.
     */
    expectTypeOf<Partial<PeriscopeConfig>>().toEqualTypeOf<PeriscopeConfig>()
    expectTypeOf({}).toExtend<PeriscopeConfig>()
    expectTypeOf<keyof PeriscopeConfig>().toEqualTypeOf<
      | 'enabled'
      | 'applicationName'
      | 'enabledIn'
      | 'storage'
      | 'recording'
      | 'redact'
      | 'hooks'
      | 'watchers'
      | 'dashboard'
    >()
  })

  test('require every block of the resolved configuration', ({ assert, expectTypeOf }) => {
    const resolved: ResolvedPeriscopeConfig = {
      enabled: true,
      applicationName: 'default',
      enabledIn: ['development', 'test'],
      storage: { driver: 'memory', maxEntries: 10_000 },
      recording: {
        caps: {
          request: 100,
          query: 200,
          exception: 100,
          log: 100,
          event: 100,
          command: 100,
          mail: 100,
          cache: 100,
          model: 100,
          gate: 100,
          dump: 100,
          view: 100,
          http_client: 100,
          schedule: 100,
          job: 100,
          health_check: 100,
          broadcast: 100,
          redis: 100,
          session: 100,
        },
        sampleRate: 1,
        keepAlways: () => false,
        ambientRotationMs: 10_000,
        pausedFlagTtlMs: 5_000,
      },
      redact: { keys: [], headers: [], valuePatterns: false, replacement: '[REDACTED]' },
      hooks: { filter: [], tag: [] },
      watchers: {
        request: {
          enabled: true,
          slowMs: 1_000,
          captureResponse: true,
          captureInertia: true,
          responseSizeLimitKb: 64,
          captureSession: true,
          ignorePaths: [],
        },
        query: { enabled: true, slowMs: 100, hideBindings: false },
        exception: { enabled: true, captureCodeFrame: 'dev', captureProcessErrors: true },
        log: { enabled: true, level: 'warn' },
        event: { enabled: true, ignore: [] },
        command: { enabled: true, ignore: [], captureOutput: true },
        mail: { enabled: true },
        cache: { enabled: true, captureValues: false },
        model: { enabled: true, captureDirty: false },
        gate: { enabled: true, ignoreAbilities: [] },
        dump: { enabled: true },
        view: { enabled: true, captureDataKeys: true },
        http_client: { enabled: true, slowMs: 1_000 },
        health_check: { enabled: true },
        transmit: { enabled: false, capturePayload: false },
        job_schedule: { enabled: false, adapters: [], capturePayload: false },
        redis: { enabled: false, captureArguments: false },
        session: { enabled: false, captureValues: false },
        custom: [],
      },
      dashboard: {
        path: '/periscope',
        authorize: () => true,
        nPlusOneThreshold: 5,
        sseMaxClients: 5,
      },
    }

    assert.deepEqual(Object.keys(resolved).sort(), [
      'applicationName',
      'dashboard',
      'enabled',
      'enabledIn',
      'hooks',
      'recording',
      'redact',
      'storage',
      'watchers',
    ])

    /**
     * Density is the whole point of the resolved shape: consumers read it without fallbacks, so
     * no top-level key may become optional, and a `Partial` of it must not satisfy it.
     */
    expectTypeOf<Required<ResolvedPeriscopeConfig>>().toEqualTypeOf<ResolvedPeriscopeConfig>()
    expectTypeOf<Partial<ResolvedPeriscopeConfig>>().not.toEqualTypeOf<ResolvedPeriscopeConfig>()
    expectTypeOf<keyof ResolvedPeriscopeConfig>().toEqualTypeOf<
      | 'enabled'
      | 'applicationName'
      | 'enabledIn'
      | 'storage'
      | 'recording'
      | 'redact'
      | 'hooks'
      | 'watchers'
      | 'dashboard'
    >()
  })

  test('resolve the per-type caps into a dense record', ({ assert, expectTypeOf }) => {
    const caps: Record<EntryType, number> = {
      request: 100,
      query: 200,
      exception: 100,
      log: 100,
      event: 100,
      command: 100,
      mail: 100,
      cache: 100,
      model: 100,
      gate: 100,
      dump: 100,
      view: 100,
      http_client: 100,
      schedule: 100,
      job: 100,
      health_check: 100,
      broadcast: 100,
      redis: 100,
      session: 100,
    }

    assert.deepEqual(new Set(Object.keys(caps)), new Set(ENTRY_TYPES))

    expectTypeOf<ResolvedPeriscopeConfig['recording']['caps']>().toEqualTypeOf<
      Record<EntryType, number>
    >()
    expectTypeOf<Required<ResolvedPeriscopeConfig['recording']>>().toEqualTypeOf<
      ResolvedPeriscopeConfig['recording']
    >()
  })

  test('leave driver-specific resolved storage keys optional', ({ assert, expectTypeOf }) => {
    const storage: ResolvedPeriscopeConfig['storage'] = { driver: 'memory', maxEntries: 10_000 }

    assert.isUndefined(storage.connection)
    assert.isUndefined(storage.factory)
    assert.isUndefined(storage.retention)
    expectTypeOf<ResolvedPeriscopeConfig['storage']>().toEqualTypeOf<{
      driver: StorageDriverName
      connection?: string
      factory?: PeriscopeStoreFactory
      maxEntries: number
      retention?: { hours: number; keepExceptions?: boolean }
    }>()
    expectTypeOf<StorageDriverName>().toEqualTypeOf<
      'memory' | 'sqlite-local' | 'database' | 'custom'
    >()
  })

  test('keep the remaining resolved blocks dense', ({ assert, expectTypeOf }) => {
    const filter: FilterHook = () => true

    assert.isTrue(filter(IncomingEntry.make(EntryType.LOG)))

    expectTypeOf<ResolvedPeriscopeConfig['redact']>().toEqualTypeOf<{
      keys: string[]
      headers: string[]
      valuePatterns: RegExp[] | false
      replacement: string
    }>()
    expectTypeOf<ResolvedPeriscopeConfig['hooks']>().toEqualTypeOf<{
      filter: FilterHook[]
      tag: TagHook[]
    }>()
  })
})
