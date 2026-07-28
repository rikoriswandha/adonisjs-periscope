/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'

import {
  DEFAULT_DASHBOARD_AUTHORIZE,
  DEFAULT_KEEP_ALWAYS,
  defineConfig,
  isRecordingEnabled,
} from '../../src/define_config.ts'
import { PeriscopeConfigError } from '../../src/errors.ts'
import {
  DEFAULT_REDACT_HEADERS,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_VALUE_PATTERNS,
} from '../../src/recorder/redactor.ts'
import { ENTRY_TYPES, EntryType } from '../../src/types.ts'
import type { PeriscopeConfig, ResolvedPeriscopeConfig } from '../../src/types.ts'

/**
 * The exact resolved shape an application gets for an empty `config/periscope.ts`. Written out
 * as a literal rather than derived from the implementation: a defaults test that recomputes the
 * defaults proves nothing, and this is the surface every other slice codes against.
 */
const DEFAULTS: ResolvedPeriscopeConfig = {
  enabled: true,
  applicationName: 'default',
  enabledIn: ['development', 'test'],
  storage: {
    driver: 'sqlite-local',
    maxEntries: 10_000,
  },
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
      http_client: 100,
      schedule: 100,
      job: 100,
      notification: 100,
      redis: 100,
      session: 100,
    },
    sampleRate: 1,
    keepAlways: DEFAULT_KEEP_ALWAYS,
    ambientRotationMs: 10_000,
    pausedFlagTtlMs: 5_000,
  },
  redact: {
    keys: [...DEFAULT_REDACT_KEYS],
    headers: [...DEFAULT_REDACT_HEADERS],
    valuePatterns: [...DEFAULT_REDACT_VALUE_PATTERNS],
    replacement: '[REDACTED]',
  },
  hooks: {
    filter: [],
    tag: [],
  },
  watchers: {
    request: {
      enabled: true,
      slowMs: 1_000,
      captureResponse: true,
      responseSizeLimitKb: 64,
      captureSession: true,
    },
    query: {
      enabled: true,
      slowMs: 100,
      hideBindings: false,
    },
    exception: {
      enabled: true,
      captureCodeFrame: 'dev',
      captureProcessErrors: true,
    },
    log: {
      enabled: true,
      level: 'warn',
    },
    event: {
      enabled: true,
      ignore: [],
    },
    command: {
      enabled: true,
      ignore: [],
    },
    mail: {
      enabled: true,
    },
    cache: {
      enabled: true,
      captureValues: false,
    },
    model: {
      enabled: true,
      captureDirty: false,
    },
    gate: {
      enabled: true,
      ignoreAbilities: [],
    },
    dump: {
      enabled: true,
    },
    http_client: {
      enabled: true,
    },
    job_schedule: { enabled: false, adapters: [], capturePayload: false },
    redis: { enabled: false, captureArguments: false },
    session: { enabled: false, captureValues: false },
  },
  dashboard: {
    path: '/periscope',
    authorize: DEFAULT_DASHBOARD_AUTHORIZE,
    nPlusOneThreshold: 5,
  },
}

/**
 * Runs `defineConfig` expecting it to reject, and returns both the raw issues and just their
 * dotted paths.
 *
 * Tests assert on the path rather than the whole sentence: the path is the contract an
 * application relies on to find the offending line, the wording is free to improve.
 *
 * The parameter is `unknown` because most of these inputs are deliberately ill-typed — the point
 * of runtime validation is the JavaScript caller, the environment-driven config and the value
 * TypeScript already lost track of.
 */
function rejectionOf(config: unknown): { issues: string[]; paths: string[] } {
  try {
    defineConfig(config as PeriscopeConfig)
  } catch (error) {
    if (!(error instanceof PeriscopeConfigError)) {
      throw error
    }

    return {
      issues: error.issues,
      paths: error.issues.map((issue) => issue.slice(0, issue.indexOf(':'))),
    }
  }

  throw new Error('expected defineConfig() to throw a PeriscopeConfigError, it returned')
}

function authorizationContext(inProduction: boolean) {
  return {
    containerResolver: {
      make: async () => ({ inProduction }),
    },
  } as unknown as Parameters<typeof DEFAULT_DASHBOARD_AUTHORIZE>[0]
}

test.group('defineConfig | defaults', () => {
  test('resolve an empty config to exactly the documented defaults', ({ assert }) => {
    assert.deepEqual(defineConfig({}), DEFAULTS)
  })

  test('deny production by default using the application for each request', async ({ assert }) => {
    const authorize = defineConfig({}).dashboard.authorize

    assert.isTrue(await authorize(authorizationContext(false)))
    assert.isFalse(await authorize(authorizationContext(true)))
    assert.isTrue(await authorize(authorizationContext(false)))
  })

  test('keep an application-defined authorizer instead of the production default', async ({
    assert,
  }) => {
    const authorize = async () => true
    const config = defineConfig({ dashboard: { authorize } })

    assert.strictEqual(config.dashboard.authorize, authorize)
    assert.isTrue(await config.dashboard.authorize(authorizationContext(true)))
  })

  test('default to the durable sqlite-local driver, not the ring buffer', ({ assert }) => {
    /**
     * Asserted on its own as well as inside the defaults literal above, because it is the one
     * default a user never sees and always feels: an application that configures nothing must
     * still have its entries survive the restart caused by the crash it is investigating.
     */
    assert.equal(defineConfig({}).storage.driver, 'sqlite-local')
  })

  test('leave storage.connection absent when it was not configured', ({ assert }) => {
    assert.notProperty(defineConfig({}).storage, 'connection')
  })

  test('keep storage.connection when it was configured', ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'database', connection: 'periscope' } })

    assert.deepEqual(config.storage, {
      driver: 'database',
      connection: 'periscope',
      maxEntries: 10_000,
    })
  })

  test('never alias the default arrays between two resolutions', ({ assert }) => {
    const first = defineConfig({})
    const second = defineConfig({})

    first.redact.keys.push('mutated')
    first.enabledIn.push('staging')
    first.watchers.command.ignore.push('mutated')
    first.watchers.gate.ignoreAbilities.push('mutated')

    assert.notInclude(second.redact.keys, 'mutated')
    assert.notInclude(second.enabledIn, 'staging')
    assert.notInclude(second.watchers.command.ignore, 'mutated')
    assert.notInclude(second.watchers.gate.ignoreAbilities, 'mutated')
  })
})

test.group('defineConfig | merging', () => {
  test('merge a nested block key by key without clobbering its siblings', ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })

    assert.equal(config.storage.driver, 'memory')
    assert.equal(config.storage.maxEntries, 10_000)
  })

  test('merge a sparse watcher override without disturbing watcher defaults', ({ assert }) => {
    const config = defineConfig({ watchers: { query: { slowMs: 5 } } })

    assert.deepEqual(config.watchers.query, {
      ...DEFAULTS.watchers.query,
      slowMs: 5,
    })
    assert.deepEqual(config.watchers.request, DEFAULTS.watchers.request)
    assert.deepEqual(config.watchers.exception, DEFAULTS.watchers.exception)
    assert.deepEqual(config.watchers.log, DEFAULTS.watchers.log)
    assert.deepEqual(config.watchers.event, DEFAULTS.watchers.event)
    assert.deepEqual(config.watchers.command, DEFAULTS.watchers.command)
    assert.deepEqual(config.watchers.mail, DEFAULTS.watchers.mail)
    assert.deepEqual(config.watchers.cache, DEFAULTS.watchers.cache)
    assert.deepEqual(config.watchers.model, DEFAULTS.watchers.model)
    assert.deepEqual(config.watchers.gate, DEFAULTS.watchers.gate)
    assert.deepEqual(config.watchers.dump, DEFAULTS.watchers.dump)
    assert.deepEqual(config.watchers.http_client, DEFAULTS.watchers.http_client)
  })

  test('resolve every watcher override into its dense shape', ({ assert }) => {
    const config = defineConfig({
      watchers: {
        command: { enabled: false, ignore: ['health:check'] },
        mail: { enabled: false },
        cache: { enabled: false, captureValues: true },
        model: { enabled: false, captureDirty: true },
        gate: { enabled: false, ignoreAbilities: ['admin'] },
        dump: { enabled: false },
        http_client: { enabled: false },
      },
    })

    assert.deepEqual(config.watchers.command, {
      enabled: false,
      ignore: ['health:check'],
    })
    assert.deepEqual(config.watchers.mail, { enabled: false })
    assert.deepEqual(config.watchers.cache, { enabled: false, captureValues: true })
    assert.deepEqual(config.watchers.model, { enabled: false, captureDirty: true })
    assert.deepEqual(config.watchers.gate, {
      enabled: false,
      ignoreAbilities: ['admin'],
    })
    assert.deepEqual(config.watchers.dump, { enabled: false })
    assert.deepEqual(config.watchers.http_client, { enabled: false })
  })

  test('normalise a trailing slash from the dashboard path but preserve the root', ({ assert }) => {
    assert.equal(defineConfig({ dashboard: { path: '/periscope/' } }).dashboard.path, '/periscope')
    assert.equal(defineConfig({ dashboard: { path: '/' } }).dashboard.path, '/')
  })

  test('merge dashboard authorization and N+1 threshold over defaults', async ({ assert }) => {
    const authorize = async () => false
    const config = defineConfig({
      dashboard: { authorize, nPlusOneThreshold: 9 },
    })

    assert.strictEqual(config.dashboard.authorize, authorize)
    assert.equal(config.dashboard.nPlusOneThreshold, 9)
    assert.isFalse(await config.dashboard.authorize({} as never))
  })

  test('leave untouched blocks at their defaults', ({ assert }) => {
    const config = defineConfig({ recording: { ambientRotationMs: 2_000 } })

    assert.equal(config.recording.ambientRotationMs, 2_000)
    assert.equal(config.recording.pausedFlagTtlMs, 5_000)
    assert.deepEqual(config.redact.headers, [...DEFAULT_REDACT_HEADERS])
    assert.equal(config.storage.maxEntries, 10_000)
  })

  test('merge sampling overrides without disturbing recording siblings', ({ assert }) => {
    const keepAlways = () => true
    const config = defineConfig({ recording: { sampleRate: 0.25, keepAlways } })

    assert.equal(config.recording.sampleRate, 0.25)
    assert.strictEqual(config.recording.keepAlways, keepAlways)
    assert.equal(config.recording.ambientRotationMs, 10_000)
    assert.equal(config.recording.pausedFlagTtlMs, 5_000)
  })

  test('replace redaction arrays instead of concatenating them', ({ assert }) => {
    const config = defineConfig({ redact: { keys: ['internal_reference'] } })

    assert.deepEqual(config.redact.keys, ['internal_reference'])
    assert.deepEqual(config.redact.headers, [...DEFAULT_REDACT_HEADERS])
    assert.deepEqual(config.redact.valuePatterns, [...DEFAULT_REDACT_VALUE_PATTERNS])
  })

  test('extend the shipped redaction list only when it is spread explicitly', ({ assert }) => {
    const config = defineConfig({ redact: { keys: [...DEFAULT_REDACT_KEYS, 'internal_ref'] } })

    assert.lengthOf(config.redact.keys, DEFAULT_REDACT_KEYS.length + 1)
    assert.include(config.redact.keys, 'password')
    assert.include(config.redact.keys, 'internal_ref')
  })

  test('replace or disable value patterns explicitly', ({ assert }) => {
    const custom = /tenant-secret-[a-z]+/g

    const replaced = defineConfig({ redact: { valuePatterns: [custom] } })
    if (replaced.redact.valuePatterns === false) {
      throw new Error('value patterns were unexpectedly disabled')
    }
    assert.deepEqual(replaced.redact.valuePatterns, [custom])
    assert.notStrictEqual(replaced.redact.valuePatterns[0], custom)

    assert.isFalse(defineConfig({ redact: { valuePatterns: false } }).redact.valuePatterns)
  })

  test('replace enabledIn instead of appending to it', ({ assert }) => {
    assert.deepEqual(defineConfig({ enabledIn: ['staging'] }).enabledIn, ['staging'])
  })

  test('replace hook arrays and keep the sibling list empty', ({ assert }) => {
    const filter = () => true
    const config = defineConfig({ hooks: { filter: [filter] } })

    assert.deepEqual(config.hooks.filter, [filter])
    assert.deepEqual(config.hooks.tag, [])
  })

  test('copy the arrays it was given so later user mutation cannot reach the recorder', ({
    assert,
  }) => {
    const keys = ['one']
    const config = defineConfig({ redact: { keys } })

    keys.push('two')

    assert.deepEqual(config.redact.keys, ['one'])
  })

  test('copy the value-pattern array and its stateful expressions', ({ assert }) => {
    const pattern = /tenant-secret-[a-z]+/g
    const patterns = [pattern]
    const config = defineConfig({ redact: { valuePatterns: patterns } })

    patterns.push(/later/)
    pattern.lastIndex = 12

    if (config.redact.valuePatterns === false) {
      throw new Error('value patterns were unexpectedly disabled')
    }
    assert.lengthOf(config.redact.valuePatterns, 1)
    assert.equal(config.redact.valuePatterns[0].lastIndex, 0)
  })

  test('accept an empty string as the redaction replacement', ({ assert }) => {
    assert.equal(defineConfig({ redact: { replacement: '' } }).redact.replacement, '')
  })
})

test.group('defineConfig | caps', () => {
  test('resolve a sparse caps map densely over every entry type', ({ assert }) => {
    const { caps } = defineConfig({ recording: { caps: { default: 5 } } }).recording

    assert.deepEqual(Object.keys(caps).sort(), [...ENTRY_TYPES].sort())

    for (const type of ENTRY_TYPES) {
      assert.equal(caps[type], 5)
    }
  })

  test('prefer an explicit per-type cap over the user default', ({ assert }) => {
    const { caps } = defineConfig({ recording: { caps: { default: 5, query: 7 } } }).recording

    assert.equal(caps[EntryType.QUERY], 7)
    assert.equal(caps[EntryType.REQUEST], 5)
    assert.equal(caps[EntryType.LOG], 5)
  })

  test('fall back to the built-in per-type default without a user default', ({ assert }) => {
    const { caps } = defineConfig({ recording: { caps: { log: 3 } } }).recording

    assert.equal(caps[EntryType.LOG], 3)
    assert.equal(caps[EntryType.QUERY], 200)
    assert.equal(caps[EntryType.REQUEST], 100)
  })

  test('let a user default override the built-in query cap', ({ assert }) => {
    const { caps } = defineConfig({ recording: { caps: { default: 1 } } }).recording

    assert.equal(caps[EntryType.QUERY], 1)
  })

  test('accept zero as a cap, meaning record none of that type', ({ assert }) => {
    const { caps } = defineConfig({ recording: { caps: { dump: 0 } } }).recording

    assert.equal(caps[EntryType.DUMP], 0)
    assert.equal(caps[EntryType.LOG], 100)
  })
})

test.group('defineConfig | validation', () => {
  test('throw a PeriscopeConfigError rather than a bare Error', ({ assert }) => {
    assert.throws(
      () => defineConfig({ storage: { maxEntries: -1 } }),
      PeriscopeConfigError,
      /storage\.maxEntries/
    )
  })

  test('reject a non-boolean enabled', ({ assert }) => {
    assert.include(rejectionOf({ enabled: 'yes' }).paths, 'enabled')
  })

  test('reject an enabledIn that is not an array', ({ assert }) => {
    assert.include(rejectionOf({ enabledIn: 'development' }).paths, 'enabledIn')
  })

  test('reject an empty enabledIn', ({ assert }) => {
    assert.include(rejectionOf({ enabledIn: [] }).paths, 'enabledIn')
  })

  test('reject a blank environment name and name its index', ({ assert }) => {
    assert.include(rejectionOf({ enabledIn: ['development', '  '] }).paths, 'enabledIn[1]')
  })

  test('reject a null block instead of merging it away', ({ assert }) => {
    const { issues, paths } = rejectionOf({ storage: null })

    assert.include(paths, 'storage')
    assert.include(issues[0], 'null')
  })

  test('reject an array where a block is expected', ({ assert }) => {
    assert.include(rejectionOf({ recording: [] }).paths, 'recording')
  })

  test('reject an unknown storage driver and name the allowed set', ({ assert }) => {
    const { issues, paths } = rejectionOf({ storage: { driver: 'postgres' } })

    assert.include(paths, 'storage.driver')
    assert.include(issues[0], 'memory, sqlite-local, database')
  })

  test('reject a blank storage connection', ({ assert }) => {
    assert.include(rejectionOf({ storage: { connection: '' } }).paths, 'storage.connection')
  })

  test('reject a non-positive maxEntries', ({ assert }) => {
    assert.include(rejectionOf({ storage: { maxEntries: 0 } }).paths, 'storage.maxEntries')
  })

  test('reject a fractional maxEntries', ({ assert }) => {
    assert.include(rejectionOf({ storage: { maxEntries: 1.5 } }).paths, 'storage.maxEntries')
  })

  test('reject a cap that is negative', ({ assert }) => {
    assert.include(
      rejectionOf({ recording: { caps: { query: -1 } } }).paths,
      'recording.caps.query'
    )
  })

  test('reject a cap that is not a safe integer', ({ assert }) => {
    assert.include(
      rejectionOf({ recording: { caps: { query: Number.NaN } } }).paths,
      'recording.caps.query'
    )
  })

  test('reject an unknown cap key and name the offending key', ({ assert }) => {
    const { issues, paths } = rejectionOf({ recording: { caps: { queries: 10 } } })

    assert.include(paths, 'recording.caps.queries')
    assert.include(issues[0], 'default')
  })

  test('reject a non-positive ambient rotation', ({ assert }) => {
    assert.include(
      rejectionOf({ recording: { ambientRotationMs: 0 } }).paths,
      'recording.ambientRotationMs'
    )
  })

  test('reject a negative paused flag ttl', ({ assert }) => {
    assert.include(
      rejectionOf({ recording: { pausedFlagTtlMs: -5 } }).paths,
      'recording.pausedFlagTtlMs'
    )
  })

  test('reject redaction keys that are not an array', ({ assert }) => {
    assert.include(rejectionOf({ redact: { keys: 'password' } }).paths, 'redact.keys')
  })

  test('reject a blank redaction header', ({ assert }) => {
    assert.include(rejectionOf({ redact: { headers: [''] } }).paths, 'redact.headers[0]')
  })

  test('reject value patterns that are neither regular expressions nor false', ({ assert }) => {
    assert.include(
      rejectionOf({ redact: { valuePatterns: ['password'] } }).paths,
      'redact.valuePatterns[0]'
    )
    assert.include(rejectionOf({ redact: { valuePatterns: true } }).paths, 'redact.valuePatterns')
  })

  test('reject a non-string replacement', ({ assert }) => {
    assert.include(rejectionOf({ redact: { replacement: 5 } }).paths, 'redact.replacement')
  })

  /**
   * `serialization` was a config block that nothing read: `safeSerialize` has always
   * fallen back to its own `SERIALIZER_DEFAULTS`. Lowering `maxBytes` therefore changed nothing,
   * which is worse than a rejection — so the key is gone and writing it is now a plain typo.
   */
  test('reject serialization as an unknown top-level key', ({ assert }) => {
    assert.throws(
      // @ts-expect-error `serialization` is no longer a Periscope config key.
      () => defineConfig({ serialization: { maxBytes: 99 } }),
      PeriscopeConfigError,
      /serialization/
    )

    const { issues, paths } = rejectionOf({ serialization: { maxBytes: 99 } })

    assert.include(paths, 'serialization')
    assert.include(issues[0], 'unknown option')
  })

  test('reject sampling rates outside the inclusive zero-to-one range', ({ assert }) => {
    for (const sampleRate of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.include(rejectionOf({ recording: { sampleRate } }).paths, 'recording.sampleRate')
    }
  })

  test('reject a keepAlways value that is not a function', ({ assert }) => {
    assert.include(rejectionOf({ recording: { keepAlways: true } }).paths, 'recording.keepAlways')
  })

  test('reject a hook that is not a function', ({ assert }) => {
    assert.include(rejectionOf({ hooks: { filter: [null] } }).paths, 'hooks.filter[0]')
  })

  test('reject a hook list that is not an array', ({ assert }) => {
    assert.include(rejectionOf({ hooks: { tag: 'nope' } }).paths, 'hooks.tag')
  })

  test('reject an unknown top-level key and list the accepted ones', ({ assert }) => {
    const { issues, paths } = rejectionOf({ redaction: { keys: [] } })

    assert.include(paths, 'redaction')
    assert.include(issues[0], 'redact')
    assert.include(issues[0], 'hooks')
  })

  test('reject an unknown key inside a known block', ({ assert }) => {
    assert.include(rejectionOf({ storage: { drivers: 'memory' } }).paths, 'storage.drivers')
  })

  test('reject an unknown watcher key', ({ assert }) => {
    assert.include(rejectionOf({ watchers: { schedule: {} } }).paths, 'watchers.schedule')
  })

  test('reject an unknown request watcher key', ({ assert }) => {
    assert.include(
      rejectionOf({ watchers: { request: { timeout: 50 } } }).paths,
      'watchers.request.timeout'
    )
  })

  test('reject a non-boolean watcher enabled flag', ({ assert }) => {
    assert.include(
      rejectionOf({ watchers: { request: { enabled: 'yes' } } }).paths,
      'watchers.request.enabled'
    )
  })

  test('reject a negative query slow threshold', ({ assert }) => {
    assert.include(
      rejectionOf({ watchers: { query: { slowMs: -1 } } }).paths,
      'watchers.query.slowMs'
    )
  })

  test('reject an unknown query location capture mode', ({ assert }) => {
    assert.include(
      rejectionOf({ watchers: { exception: { captureCodeFrame: 'sometimes' } } }).paths,
      'watchers.exception.captureCodeFrame'
    )
  })

  test('reject an unknown log level', ({ assert }) => {
    assert.include(
      rejectionOf({ watchers: { log: { level: 'warning' } } }).paths,
      'watchers.log.level'
    )
  })

  test('reject an event ignore value that is not an array', ({ assert }) => {
    assert.include(
      rejectionOf({ watchers: { event: { ignore: 'order.*' } } }).paths,
      'watchers.event.ignore'
    )
  })

  test('reject invalid watcher-specific options', ({ assert }) => {
    assert.include(
      rejectionOf({ watchers: { command: { ignore: 'periscope:clear' } } }).paths,
      'watchers.command.ignore'
    )
    assert.include(
      rejectionOf({ watchers: { cache: { captureValues: 'yes' } } }).paths,
      'watchers.cache.captureValues'
    )
    assert.include(
      rejectionOf({ watchers: { model: { captureDirty: 'yes' } } }).paths,
      'watchers.model.captureDirty'
    )
    assert.include(
      rejectionOf({ watchers: { gate: { ignoreAbilities: 'admin' } } }).paths,
      'watchers.gate.ignoreAbilities'
    )
  })

  test('reject a dashboard path that is not a string', ({ assert }) => {
    assert.include(rejectionOf({ dashboard: { path: 42 } }).paths, 'dashboard.path')
  })

  test('reject an empty dashboard path', ({ assert }) => {
    assert.include(rejectionOf({ dashboard: { path: '' } }).paths, 'dashboard.path')
  })

  test('reject a dashboard path without a leading slash', ({ assert }) => {
    assert.include(rejectionOf({ dashboard: { path: 'periscope' } }).paths, 'dashboard.path')
  })

  test('reject a dashboard authorization hook that is not a function', ({ assert }) => {
    assert.include(rejectionOf({ dashboard: { authorize: true } }).paths, 'dashboard.authorize')
  })

  test('reject a non-positive dashboard N+1 threshold', ({ assert }) => {
    assert.include(
      rejectionOf({ dashboard: { nPlusOneThreshold: 0 } }).paths,
      'dashboard.nPlusOneThreshold'
    )
  })

  test('reject a config that is not an object at all', ({ assert }) => {
    assert.include(rejectionOf(null).paths, 'config')
  })

  test('report every problem in a single throw', ({ assert }) => {
    const { paths } = rejectionOf({
      enabled: 'yes',
      storage: { driver: 'postgres' },
      recording: { ambientRotationMs: 0 },
    })

    assert.deepEqual([...paths].sort(), [
      'enabled',
      'recording.ambientRotationMs',
      'storage.driver',
    ])
  })

  test('report every problem inside one block together', ({ assert }) => {
    const { paths } = rejectionOf({
      recording: { caps: { query: -1, nope: 1 }, pausedFlagTtlMs: 0 },
    })

    assert.deepEqual([...paths].sort(), [
      'recording.caps.nope',
      'recording.caps.query',
      'recording.pausedFlagTtlMs',
    ])
  })
})

test.group('defineConfig | types', () => {
  test('resolve to the dense ResolvedPeriscopeConfig shape', ({ expectTypeOf }) => {
    expectTypeOf(defineConfig({})).toEqualTypeOf<ResolvedPeriscopeConfig>()
    expectTypeOf(defineConfig({}).recording.caps).toEqualTypeOf<Record<EntryType, number>>()
    expectTypeOf(defineConfig({}).storage.driver).toEqualTypeOf<
      'memory' | 'sqlite-local' | 'database'
    >()
  })

  test('reject an unknown top-level key at compile time as well', ({ assert }) => {
    // @ts-expect-error `redaction` is not a Periscope config key. The compiler must catch the
    // typo in an application's config literal; the runtime check below is the safety net for
    // values TypeScript cannot see.
    assert.throws(() => defineConfig({ redaction: { keys: [] } }), PeriscopeConfigError)
  })

  test('reject an unknown storage driver at compile time as well', ({ assert }) => {
    // @ts-expect-error 'postgres' is not a StorageDriverName.
    assert.throws(() => defineConfig({ storage: { driver: 'postgres' } }), PeriscopeConfigError)
  })
})

test.group('isRecordingEnabled', () => {
  const config = { enabled: true, enabledIn: ['development', 'test'] }
  const disabled = { enabled: false, enabledIn: ['development', 'test'] }

  test('record in a listed environment when enabled', ({ assert }) => {
    assert.isTrue(isRecordingEnabled(config, { nodeEnv: 'development' }))
  })

  test('stay off in an unlisted environment', ({ assert }) => {
    assert.isFalse(isRecordingEnabled(config, { nodeEnv: 'production' }))
  })

  test('stay off when the master switch is off', ({ assert }) => {
    assert.isFalse(isRecordingEnabled(disabled, { nodeEnv: 'development' }))
  })

  test('force recording on for a recognised truthy override', ({ assert }) => {
    for (const periscopeEnabled of ['1', 'true', 'TRUE', '  true  ']) {
      assert.isTrue(isRecordingEnabled(disabled, { nodeEnv: 'production', periscopeEnabled }))
    }
  })

  test('force recording off for a recognised falsy override', ({ assert }) => {
    for (const periscopeEnabled of ['0', 'false', 'False', ' 0 ']) {
      assert.isFalse(isRecordingEnabled(config, { nodeEnv: 'development', periscopeEnabled }))
    }
  })

  test('ignore an unrecognised override and fall back to the config', ({ assert }) => {
    for (const periscopeEnabled of ['', '  ', 'maybe', 'yes', '2']) {
      assert.isTrue(isRecordingEnabled(config, { nodeEnv: 'development', periscopeEnabled }))
      assert.isFalse(isRecordingEnabled(config, { nodeEnv: 'production', periscopeEnabled }))
    }
  })

  test('ignore an override that collides with an Object.prototype key', ({ assert }) => {
    assert.isFalse(
      isRecordingEnabled(config, { nodeEnv: 'production', periscopeEnabled: 'constructor' })
    )
  })

  test('fall back to the config when the variable is unset', ({ assert }) => {
    assert.isTrue(isRecordingEnabled(config, { nodeEnv: 'test', periscopeEnabled: undefined }))
  })

  test('read the resolved config it is handed', ({ assert }) => {
    const resolved = defineConfig({ enabledIn: ['staging'] })

    assert.isTrue(isRecordingEnabled(resolved, { nodeEnv: 'staging' }))
    assert.isFalse(isRecordingEnabled(resolved, { nodeEnv: 'development' }))
  })
})
