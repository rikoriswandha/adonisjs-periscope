/*
|--------------------------------------------------------------------------
| Showcase seed
|--------------------------------------------------------------------------
|
| Every dashboard section needs representative data before a visitor knows which playground
| actions exercise its watcher. On boot, the dev server therefore records one realistic entry for
| every entry type.
|
| Redis, job, schedule, and dump also have no ambient source in the playground: nothing traces
| Redis commands, no queue runs, and `dump()` records only while the dashboard holds a `dump-open`
| lease. The seed exercises those real watcher pipelines on boot and every minute, while the full
| catalogue is boot-only so it does not add 27 rows per minute. Tests never run this seed.
|
*/

import { setTimeout as sleep } from 'node:timers/promises'
import { tracingChannel } from 'node:diagnostics_channel'

import app from '@adonisjs/core/services/app'
import recorder from '@rikology/adonisjs-periscope/services/recorder'
import { dump } from '@rikology/adonisjs-periscope/dump'
import {
  BatchScope,
  ENTRY_TYPES,
  EntryType,
  Flag,
  IncomingEntry,
} from '@rikology/adonisjs-periscope'
import type { EntryContent } from '@rikology/adonisjs-periscope'

import { demoQueue } from '../app/periscope/demo_queue_adapter.js'

/**
 * The channel @adonisjs/redis publishes command traces on; the RedisWatcher observes the channel,
 * not a connection, so fake traces exercise the real pipeline.
 */
const redisChannel = tracingChannel<'adonisjs.redis.command', object>('adonisjs.redis.command')

/**
 * The DumpWatcher polls the `dump-open` flag on this cadence; the seed must outwait one poll
 * before its `dump()` call can land.
 */
const DUMP_FLAG_POLL_MS = 1_000

const RESEED_INTERVAL_MS = 60_000

/**
 * One representative payload for every dashboard section. Keeping this exhaustive makes a new
 * entry type fail the playground typecheck until its empty state also gets showcase data.
 */
const SHOWCASE_ENTRIES = {
  [EntryType.REQUEST]: {
    method: 'GET',
    url: '/showcase?tab=overview',
    query: { tab: 'overview' },
    routePattern: '/showcase',
    routeName: 'showcase',
    headers: { 'accept': 'text/html', 'user-agent': 'Periscope showcase' },
    payload: {},
    status: 200,
    durationMs: 18.7,
    user: { id: 42, email: 'showcase@periscope.test' },
    memoryDeltaBytes: 24_576,
    ip: '127.0.0.1',
    hostname: 'localhost',
    response: { page: 'showcase', entryTypes: ENTRY_TYPES.length },
    clientDisconnected: false,
  },
  [EntryType.QUERY]: {
    sql: 'select * from "users" where "id" = ? limit ?',
    bindings: [42, 1],
    connection: 'sqlite',
    model: 'User',
    method: 'select',
    durationMs: 3.4,
    inTransaction: false,
    ddl: false,
  },
  [EntryType.EXCEPTION]: {
    name: 'ShowcaseError',
    message: 'A representative playground exception',
    code: 'E_SHOWCASE',
    status: 500,
    stack:
      'ShowcaseError: A representative playground exception\n    at ShowcaseController.handle (app/controllers/showcase_controller.ts:42:11)',
    frames: [
      {
        file: 'app/controllers/showcase_controller.ts',
        line: 42,
        column: 11,
        function: 'ShowcaseController.handle',
        type: 'app',
        raw: 'at ShowcaseController.handle (app/controllers/showcase_controller.ts:42:11)',
      },
    ],
    codeFrame: [
      { line: 41, source: 'if (shouldDemonstrateFailure) {', highlight: false },
      {
        line: 42,
        source: "  throw new ShowcaseError('A representative playground exception')",
        highlight: true,
      },
      { line: 43, source: '}', highlight: false },
    ],
    request: {
      method: 'GET',
      url: '/showcase/failure',
      route: { pattern: '/showcase/failure', name: 'showcase.failure' },
    },
    context: { feature: 'playground-seed' },
  },
  [EntryType.LOG]: {
    level: 'warn',
    levelNumber: 40,
    message: 'Showcase inventory is running low',
    context: { sku: 'PERISCOPE-42', remaining: 3 },
    time: new Date().toISOString(),
  },
  [EntryType.EVENT]: {
    name: 'order:placed',
    payload: { orderId: 42, total: 129.5, currency: 'USD' },
    isClassEvent: false,
    listenerCount: 3,
  },
  [EntryType.COMMAND]: {
    command: 'showcase:sync',
    args: { tenant: 'demo' },
    flags: { force: true },
    isMain: true,
    exitCode: 0,
    durationMs: 86.2,
    output: 'Synced 12 showcase records',
  },
  [EntryType.MAIL]: {
    event: 'sent',
    mailer: 'smtp',
    envelope: {
      from: 'hello@periscope.test',
      to: ['showcase@periscope.test'],
    },
    subject: 'Welcome to the Periscope showcase',
    html: '<h1>Welcome</h1><p>Your dashboard is ready.</p>',
    text: 'Welcome. Your dashboard is ready.',
    messageId: 'showcase-message-42',
    response: { accepted: ['showcase@periscope.test'] },
  },
  [EntryType.CACHE]: {
    operation: 'hit',
    store: 'redis',
    key: 'showcase:catalogue',
    layer: 'l2',
    graced: false,
    value: { entryTypes: ENTRY_TYPES.length },
  },
  [EntryType.MODEL]: {
    action: 'update',
    model: 'User',
    primaryKey: 'id',
    primaryKeyValue: 42,
    attributes: { id: 42, email: 'showcase@periscope.test', active: true },
    dirty: { active: true },
  },
  [EntryType.GATE]: {
    ability: 'editProject',
    allowed: false,
    userId: 42,
    user: { id: 42, email: 'showcase@periscope.test' },
    args: [{ projectId: 7 }],
    status: 403,
    message: 'Only project owners can edit this project',
  },
  [EntryType.DUMP]: {
    values: [
      {
        seeded: true,
        feature: 'showcase-catalogue',
        nested: { visible: 'in the structured value inspector' },
      },
    ],
    caller: { file: 'start/showcase_seed.ts', line: 42, column: 1 },
  },
  [EntryType.VIEW]: {
    template: 'pages/showcase',
    durationMs: 6.8,
    dataKeys: ['user', 'navigation', 'entryTypes'],
  },
  [EntryType.HTTP_CLIENT]: {
    method: 'GET',
    url: 'https://api.periscope.test/catalogue',
    status: 200,
    durationMs: 42.6,
    requestHeaders: { accept: 'application/json' },
    responseHeaders: { 'content-type': 'application/json', 'x-request-id': 'showcase-42' },
    completed: true,
  },
  [EntryType.SCHEDULE]: {
    adapter: 'playground-demo',
    queue: 'maintenance',
    jobId: 'showcase-schedule-42',
    name: 'prune-old-entries',
    scheduledAt: new Date(Date.now() + RESEED_INTERVAL_MS).toISOString(),
    delayMs: RESEED_INTERVAL_MS,
    payload: { retainDays: 7 },
  },
  [EntryType.JOB]: {
    adapter: 'playground-demo',
    queue: 'emails',
    jobId: 'showcase-job-42',
    name: 'send-welcome-email',
    status: 'completed',
    durationMs: 24.3,
    attempts: 1,
    payload: { userId: 42 },
    result: { delivered: true },
  },
  [EntryType.HEALTH_CHECK]: {
    status: 'error',
    checks: [
      { name: 'database', status: 'ok', durationMs: 2.1 },
      {
        name: 'redis',
        status: 'warning',
        durationMs: 38.4,
        message: 'Latency is above the preferred threshold',
      },
      {
        name: 'mail',
        status: 'error',
        durationMs: 101.7,
        message: 'SMTP connection refused',
      },
      { name: 'optional-search', status: 'unknown', message: 'Integration is not configured' },
    ],
  },
  [EntryType.BROADCAST]: {
    channel: 'orders.42',
    event: 'OrderUpdated',
    payloadSummary: { orderId: 42, status: 'shipped' },
  },
  [EntryType.REDIS]: {
    command: 'mget',
    argumentCount: 2,
    arguments: ['showcase:user:42', 'showcase:order:42'],
    durationMs: 1.9,
  },
  [EntryType.SESSION]: {
    operation: 'committed',
    sessionIdHash: 'sha256:showcase-session',
    fresh: false,
    readonly: false,
    modified: true,
    values: { locale: 'en', cartItems: 2 },
  },
  [EntryType.VALIDATION]: {
    errorCount: 2,
    fields: ['email', 'password'],
    errors: [
      { field: 'email', rule: 'email', message: 'The email field must be a valid email address' },
      {
        field: 'password',
        rule: 'minLength',
        message: 'The password field must have at least 12 characters',
        meta: { min: 12 },
      },
    ],
  },
  [EntryType.RATE_LIMIT]: {
    key: 'login:127.0.0.1',
    action: 'rejected',
    limit: 5,
    remaining: 0,
    retryAfterMs: 30_000,
    store: 'redis',
  },
  [EntryType.LOCK]: {
    key: 'showcase:report:42',
    action: 'timeout',
    waitedMs: 250,
    ttlMs: 5_000,
  },
  [EntryType.DRIVE]: {
    operation: 'copy',
    key: 'uploads/showcase-avatar.png',
    disk: 's3',
    durationMs: 74.2,
    destination: 'avatars/user-42.png',
    sizeBytes: 84_120,
  },
  [EntryType.ALLY]: {
    provider: 'github',
    operation: 'callback',
    durationMs: 316.8,
    user: { id: 'octocat', email: 'showcase@periscope.test' },
  },
  [EntryType.I18N]: {
    locale: 'fr',
    identifier: 'messages.checkout.complete',
    hasFallback: true,
  },
  [EntryType.NOTIFICATION]: {
    adapter: 'database',
    channel: 'orders',
    notification: 'OrderShipped',
    status: 'sent',
    notifiable: 42,
    durationMs: 12.5,
    payload: { orderId: 42, trackingCode: 'SHOWCASE-42' },
  },
  [EntryType.SOCKET]: {
    adapter: 'transmit',
    socketId: 'showcase-socket-42',
    event: 'message',
    transport: 'websocket',
    channel: 'orders.42',
    remoteAddress: '127.0.0.1',
    userId: 42,
    direction: 'outbound',
    messageEvent: 'OrderUpdated',
    sizeBytes: 128,
    durationMs: 2.4,
    payload: { status: 'shipped' },
  },
} satisfies Record<EntryType, EntryContent>

async function seedOnce(includeShowcaseCatalogue = false) {
  const context = BatchScope.createContext('command')

  await BatchScope.runWith(context, async () => {
    if (includeShowcaseCatalogue) {
      for (const type of ENTRY_TYPES) {
        recorder.record(
          IncomingEntry.make(type, SHOWCASE_ENTRIES[type]).withTags('showcase', `type:${type}`)
        )
      }
    }

    await redisChannel.tracePromise(async () => sleep(2), {
      command: { name: 'get', args: ['showcase:counter'] },
    })
    await redisChannel
      .tracePromise(
        async () => {
          await sleep(1)
          throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
        },
        { command: { name: 'incr', args: ['showcase:not-a-counter'] } }
      )
      .catch(() => {})

    const observer = demoQueue.observer
    if (observer !== undefined) {
      const completed = demoQueue.dispatch({
        adapter: 'playground-demo',
        queue: 'emails',
        jobId: `seed-${Date.now()}`,
        name: 'send-welcome-email',
        payload: { to: 'showcase@periscope.test', password: 'showcase-job-secret' },
        attempts: 1,
      })
      observer.started(completed)
      await demoQueue.run(completed, () => sleep(5))
      observer.completed({ ...completed, result: { delivered: true } })

      const failed = demoQueue.dispatch({
        adapter: 'playground-demo',
        queue: 'reports',
        jobId: `seed-${Date.now()}-fail`,
        name: 'generate-report',
        payload: { reportId: 42 },
        attempts: 3,
      })
      observer.started(failed)
      await demoQueue.run(failed, () => sleep(2))
      observer.failed({ ...failed, error: new Error('report template missing') })

      observer.scheduled({
        adapter: 'playground-demo',
        queue: 'maintenance',
        jobId: `seed-${Date.now()}-cron`,
        name: 'prune-old-entries',
        scheduledAt: new Date(Date.now() + RESEED_INTERVAL_MS),
      })
    }

    /**
     * Lease the dump flag exactly like a dashboard tab would, outwait one watcher poll so the
     * synchronous `dump()` gate observes it, and let the lease expire on its own.
     */
    await recorder.store.setFlag(`${Flag.DUMP_OPEN}:playground-seed`, 'playground-seed', {
      expiresAt: new Date(Date.now() + DUMP_FLAG_POLL_MS * 3),
    })
    await sleep(DUMP_FLAG_POLL_MS + 200)
    dump({ seeded: true, at: new Date().toISOString(), password: 'showcase-dump-secret' })
  })

  await recorder.flush(context)
}

app.ready(async () => {
  if (!app.inDev) {
    return
  }

  await seedOnce(true)

  const timer = setInterval(() => {
    void seedOnce().catch(() => {})
  }, RESEED_INTERVAL_MS)
  timer.unref()
})
