import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import cache from '@adonisjs/cache/services/main'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import type { Assert } from '@japa/assert'
import { test } from '@japa/runner'
import { EntryType, Flag } from 'adonisjs-periscope'
import type { StoredEntry } from 'adonisjs-periscope'
import recorder from 'adonisjs-periscope/services/recorder'

import periscopeConfig from '#config/periscope'

const POLL_INTERVAL_MS = 10
const POLL_TIMEOUT_MS = 2_000
const execFileAsync = promisify(execFile)
const PLAYGROUND_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WAVE2_USER_EMAIL = 'wave2@periscope.test'

/**
 * One page of everything recorded so far. Small enough to be the whole store, since every test
 * clears it first.
 */
async function listEntries(): Promise<StoredEntry[]> {
  const page = await recorder.store.list({ limit: 100 })
  return page.data
}

/**
 * Request completion is emitted from Node's `on-finished` callback, after the API client has its
 * response. Polling the store for the observable entry closes that scheduling gap without making
 * the suite depend on an arbitrary sleep that is either wasteful locally or flaky under CI load.
 */
async function waitForEntries(
  predicate: (entries: StoredEntry[]) => boolean
): Promise<StoredEntry[]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() <= deadline) {
    const entries = await listEntries()

    if (predicate(entries)) {
      return entries
    }

    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(`Periscope did not flush the expected entries within ${POLL_TIMEOUT_MS}ms`)
}

/**
 * A negative assertion has no entry to poll for, so it must keep looking for the whole bounded
 * window. Flushing on each pass makes an exception or log that fell into the ambient batch
 * observable immediately instead of letting the ten-second ambient rotation hide it from this
 * two-second test.
 */
async function entriesAfterSettlingWindow(): Promise<StoredEntry[]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() <= deadline) {
    await recorder.flush()

    const entries = await listEntries()

    if (entries.length > 0) {
      return entries
    }

    await sleep(POLL_INTERVAL_MS)
  }

  await recorder.flush()
  return listEntries()
}

function isRequestFor(entry: StoredEntry, url: string, status: number): boolean {
  return (
    entry.type === EntryType.REQUEST && entry.content.url === url && entry.content.status === status
  )
}

async function waitForRequestBatches(
  url: string,
  status: number,
  count = 1
): Promise<{ entries: StoredEntry[]; batches: StoredEntry[][] }> {
  const entries = await waitForEntries(
    (current) => current.filter((entry) => isRequestFor(entry, url, status)).length >= count
  )
  const requests = entries.filter((entry) => isRequestFor(entry, url, status))
  const batches = await Promise.all(
    requests.map((request) => recorder.store.batch(request.batchId))
  )

  return { entries, batches }
}

/**
 * The request entry is the batch's correlation proof. Checking both tags here keeps every route
 * assertion honest: a batch whose children agree on an id but whose primary entry cannot be
 * filtered by response status or matched route is still broken from the dashboard's perspective.
 */
function assertRequestBatch(
  assert: Assert,
  entries: StoredEntry[],
  url: string,
  status: number
): StoredEntry {
  const requests = entries.filter((entry) => entry.type === EntryType.REQUEST)

  assert.lengthOf(requests, 1)

  const request = requests[0]!
  assert.equal(request.content.url, url)
  assert.equal(request.content.status, status)
  assert.include(request.tags, `status:${status}`)
  assert.include(request.tags, `route:${url}`)
  assert.isTrue(entries.every((entry) => entry.batchId === request.batchId))

  return request
}

/**
 * The internal-log predicate is the recursion gate this sqlite-local fixture can exercise.
 * Storage writes stay on sqlite-local's private connection and never emit Lucid `db:query`
 * events, so the storage predicate below is retained as a forward guard for a future fixture
 * driver change, not as proof of today's storage exclusion. The database-driver proof lives in
 * `packages/periscope/tests/unit/watchers/query_recursion.spec.ts`, where writes run through a real
 * Lucid connection.
 */
function assertNoPeriscopeTraffic(assert: Assert, entries: StoredEntry[]): void {
  const storageQueries = entries.filter((entry) => {
    const sql = entry.content.sql

    return (
      entry.type === EntryType.QUERY &&
      typeof sql === 'string' &&
      /\bperiscope_(?:entries|entry_tags|monitored_tags|flags)\b/i.test(sql)
    )
  })
  const internalLogs = entries.filter((entry) => {
    const message = entry.content.message

    return (
      entry.type === EntryType.LOG &&
      (JSON.stringify(entry.content).includes('periscope.internal') ||
        (typeof message === 'string' && message.startsWith('periscope.')))
    )
  })

  assert.lengthOf(storageQueries, 0)
  assert.lengthOf(internalLogs, 0)
}

test.group('periscope watchers (playground wiring)', (group) => {
  group.setup(async () => {
    const resetDatabase = await testUtils.db().migrate()

    /**
     * Migration queries are legitimate ambient traffic, but they are setup rather than evidence
     * for an HTTP watcher. Drain them before the per-test clear so a later ambient rotation cannot
     * leak setup work into a request assertion.
     */
    await recorder.flush()
    await recorder.store.clear()

    return async () => {
      await resetDatabase()
      await recorder.flush()
      await recorder.store.clear()
    }
  })

  group.each.setup(() => recorder.store.clear())

  test('GET /ok records one request and its SELECT in one batch', async ({ client, assert }) => {
    const response = await client.get('/ok')

    response.assertStatus(200)

    const recorded = await waitForRequestBatches('/ok', 200)
    const batch = recorded.batches[0]!
    const request = assertRequestBatch(assert, batch, '/ok', 200)
    const queries = batch.filter((entry) => entry.type === EntryType.QUERY)
    const select = queries.find((entry) => {
      const sql = entry.content.sql
      return typeof sql === 'string' && /\bselect\b[\s\S]*\busers\b/i.test(sql)
    })

    assert.lengthOf(
      batch.filter((entry) => entry.type === EntryType.REQUEST),
      1
    )
    assert.exists(select)
    assert.equal(select!.batchId, request.batchId)
    assert.isTrue(typeof select!.content.durationMs === 'number' && select!.content.durationMs > 0)
    assert.isFalse(
      batch.some((entry) => entry.type === EntryType.EVENT && entry.content.name === 'db:query')
    )
    assertNoPeriscopeTraffic(assert, recorded.entries)
  })

  test('GET /slow tags the expensive query as slow', async ({ client, assert }) => {
    const response = await client.get('/slow')

    response.assertStatus(200)

    const recorded = await waitForRequestBatches('/slow', 200)
    const batch = recorded.batches[0]!
    assertRequestBatch(assert, batch, '/slow', 200)

    const query = batch.find((entry) => {
      const sql = entry.content.sql
      return (
        entry.type === EntryType.QUERY && typeof sql === 'string' && /with recursive/i.test(sql)
      )
    })

    assert.exists(query)
    assert.include(query!.tags, 'slow')
    assert.isTrue(typeof query!.content.durationMs === 'number' && query!.content.durationMs > 0)
    assertNoPeriscopeTraffic(assert, recorded.entries)
  })

  test('GET /boom correlates reported exceptions and groups identical failures', async ({
    client,
    assert,
  }) => {
    const first = await client.get('/boom')
    const second = await client.get('/boom')

    first.assertStatus(500)
    second.assertStatus(500)

    const recorded = await waitForRequestBatches('/boom', 500, 2)
    assert.lengthOf(recorded.batches, 2)

    const exceptions = recorded.batches.map((batch) => {
      const request = assertRequestBatch(assert, batch, '/boom', 500)
      const matching = batch.filter((entry) => entry.type === EntryType.EXCEPTION)

      assert.lengthOf(matching, 1)
      assert.equal(matching[0]!.batchId, request.batchId)

      return matching[0]!
    })

    assert.isNotNull(exceptions[0]!.familyHash)
    assert.equal(exceptions[0]!.familyHash, exceptions[1]!.familyHash)
    assertNoPeriscopeTraffic(assert, recorded.entries)
  })

  test('POST /echo redacts storage without changing the application response', async ({
    client,
    assert,
  }) => {
    const payload = { email: 'echo@periscope.test', password: 'super-secret' }
    const response = await client.post('/echo').json(payload)

    response.assertStatus(200)
    assert.deepEqual(response.body().echoed, payload)

    const recorded = await waitForRequestBatches('/echo', 200)
    const batch = recorded.batches[0]!
    const request = assertRequestBatch(assert, batch, '/echo', 200)

    assert.deepEqual(request.content.payload, {
      email: payload.email,
      password: '[REDACTED]',
    })
    assertNoPeriscopeTraffic(assert, recorded.entries)
  })

  test('the dashboard path is excluded even when it resolves to a 404', async ({
    client,
    assert,
  }) => {
    const response = await client.get(periscopeConfig.dashboard.path)

    response.assertStatus(404)

    const entries = await entriesAfterSettlingWindow()
    assert.isFalse(entries.some((entry) => entry.type === EntryType.EXCEPTION))
    assert.isFalse(entries.some((entry) => entry.type === EntryType.LOG))
    assert.lengthOf(entries, 0)
    assertNoPeriscopeTraffic(assert, entries)
  })

  test('GET /fanout records the warn log and custom class event only once', async ({
    client,
    assert,
  }) => {
    const response = await client.get('/fanout')

    response.assertStatus(200)

    const recorded = await waitForRequestBatches('/fanout', 200)
    const batch = recorded.batches[0]!
    assertRequestBatch(assert, batch, '/fanout', 200)

    const logs = batch.filter((entry) => entry.type === EntryType.LOG)
    const events = batch.filter((entry) => entry.type === EntryType.EVENT)
    const fanout = events.find((entry) => entry.content.name === 'FanoutRequested')

    assert.include(
      logs.map((entry) => entry.content.message),
      'fanout route reached'
    )
    assert.notInclude(
      logs.map((entry) => entry.content.message),
      'fanout event handled'
    )
    assert.exists(fanout)
    assert.deepInclude(fanout!.content.payload, { source: 'playground', itemsCount: 3 })
    assert.equal(fanout!.content.className, 'FanoutRequested')
    assert.isFalse(events.some((entry) => entry.content.name === 'db:query'))
    assertNoPeriscopeTraffic(assert, recorded.entries)
  })
  test('GET /wave2 exercises every Phase 6 watcher with redaction and clean state', async ({
    client,
    assert,
    cleanup,
  }) => {
    cleanup(async () => {
      await recorder.store.deleteFlag(Flag.DUMP_OPEN)
      await cache.clear()
      await db.from('users').where('email', WAVE2_USER_EMAIL).delete()
      await recorder.flush()
      await recorder.store.clear()
    })

    await recorder.store.setFlag(Flag.DUMP_OPEN, '1')
    await sleep(1_100)

    const response = await client.get('/wave2')
    response.assertStatus(200)
    response.assertBodyContains({
      cache: { missed: true, phase: 6 },
      model: { fullName: 'Wave 2 Updated' },
      gate: { allowed: true },
      dump: { phase: 6 },
      httpClient: { status: 200 },
    })

    await recorder.flush()
    const recorded = await waitForRequestBatches('/wave2', 200)
    const batch = recorded.batches[0]!
    assertRequestBatch(assert, batch, '/wave2', 200)

    const caches = batch.filter((entry) => entry.type === EntryType.CACHE)
    assert.sameMembers(
      caches.map((entry) => entry.content.operation),
      ['clear', 'miss', 'set', 'hit', 'delete']
    )
    const cacheSet = caches.find((entry) => entry.content.operation === 'set')
    const cacheHit = caches.find((entry) => entry.content.operation === 'hit')
    assert.deepInclude(cacheSet!.content, {
      store: 'default',
      key: 'wave2:fixture',
      value: { phase: 6, password: '[REDACTED]' },
    })
    assert.deepInclude(cacheHit!.content, {
      store: 'default',
      key: 'wave2:fixture',
      value: { phase: 6, password: '[REDACTED]' },
    })

    const models = batch.filter((entry) => entry.type === EntryType.MODEL)
    assert.deepEqual(models.map((entry) => entry.content.action).sort(), [
      'create',
      'delete',
      'update',
    ])
    const created = models.find((entry) => entry.content.action === 'create')
    const updated = models.find((entry) => entry.content.action === 'update')
    assert.deepInclude(created!.content, {
      model: 'User',
      primaryKey: 'id',
    })
    assert.deepInclude(created!.content.attributes, {
      fullName: 'Wave 2 Fixture',
      email: WAVE2_USER_EMAIL,
      password: '[REDACTED]',
    })
    assert.deepInclude(updated!.content, {
      model: 'User',
      dirty: { fullName: 'Wave 2 Updated' },
    })
    const deleted = models.find((entry) => entry.content.action === 'delete')
    assert.deepInclude(deleted!.content.attributes, {
      email: WAVE2_USER_EMAIL,
      password: '[REDACTED]',
    })

    const gates = batch.filter((entry) => entry.type === EntryType.GATE)
    assert.lengthOf(gates, 1)
    assert.deepInclude(gates[0]!.content, {
      ability: 'inspectWave2',
      allowed: true,
      args: [
        {
          ownerId: created!.content.primaryKeyValue,
          password: '[REDACTED]',
        },
      ],
    })

    const dumps = batch.filter((entry) => entry.type === EntryType.DUMP)
    assert.lengthOf(dumps, 1)
    assert.deepEqual(dumps[0]!.content.values, [{ phase: 6, password: '[REDACTED]' }])
    const dumpCaller = dumps[0]!.content.caller
    if (
      !dumpCaller ||
      typeof dumpCaller !== 'object' ||
      !('file' in dumpCaller) ||
      typeof dumpCaller.file !== 'string'
    ) {
      assert.fail('expected dump caller file metadata')
      return
    }
    assert.include(dumpCaller.file, 'wave2_controller')

    const sentMail = batch.find(
      (entry) => entry.type === EntryType.MAIL && entry.content.event === 'sent'
    )
    assert.exists(sentMail)
    assert.deepInclude(sentMail!.content, {
      mailer: 'json',
      subject: 'Periscope playground fanout',
      text: 'The /fanout route dispatched an event, logged a warning and sent this mail.',
    })

    const outbound = batch.filter((entry) => entry.type === EntryType.HTTP_CLIENT)
    assert.lengthOf(outbound, 1)
    const outboundUrl = new URL(outbound[0]!.content.url as string)
    assert.equal(outboundUrl.pathname, '/')
    assert.equal(outboundUrl.searchParams.get('token'), '[REDACTED]')
    assert.equal(outboundUrl.searchParams.get('phase'), '[REDACTED]')
    assert.deepInclude(outbound[0]!.content, {
      method: 'GET',
      status: 200,
      completed: true,
    })
    assert.deepInclude(outbound[0]!.content.requestHeaders, {
      'authorization': '[REDACTED]',
      'x-wave2-probe': 'true',
    })

    await execFileAsync(
      process.execPath,
      ['ace.js', 'wave2:exercise', 'phase-six', '--password=wave2-command-secret'],
      {
        cwd: PLAYGROUND_ROOT,
        env: { ...process.env, NODE_ENV: 'test' },
      }
    )
    await recorder.flush()

    const allEntries = await waitForEntries((entries) =>
      entries.some((entry) => entry.type === EntryType.COMMAND)
    )
    const commands = allEntries.filter((entry) => entry.type === EntryType.COMMAND)
    assert.lengthOf(commands, 1)
    assert.deepInclude(commands[0]!.content, {
      command: 'wave2:exercise',
      args: ['phase-six'],
      flags: { password: '[REDACTED]' },
      isMain: true,
      exitCode: 0,
    })
    assert.isAtLeast(commands[0]!.content.durationMs as number, 0)

    assert.isFalse(
      allEntries.some((entry) => {
        if (entry.type === EntryType.HTTP_CLIENT) {
          return new URL(entry.content.url as string).pathname.startsWith(
            periscopeConfig.dashboard.path
          )
        }

        return (
          entry.type === EntryType.REQUEST &&
          typeof entry.content.url === 'string' &&
          entry.content.url.startsWith(periscopeConfig.dashboard.path)
        )
      })
    )
    assertNoPeriscopeTraffic(assert, allEntries)
  }).timeout(30_000)
})
