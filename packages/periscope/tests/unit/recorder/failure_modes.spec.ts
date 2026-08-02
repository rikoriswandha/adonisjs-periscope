/*
 * periscope
 *
 * Cross-component failure-mode drills. Unit tests for the individual
 * serializer cases live in serializer.spec.ts; this file exercises a real failed driver from a
 * host HTTP request so a storage outage can never become an application outage.
 */

import { createServer, get as httpGet } from 'node:http'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from '@japa/runner'

import { defineConfig } from '../../../src/define_config.ts'
import { IncomingEntry } from '../../../src/entry.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { MONITORED_TAGS_CACHE_TTL_MS, Recorder } from '../../../src/recorder/recorder.ts'
import { setInternalLogger } from '../../../src/safeguard.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { SqliteLocalStore } from '../../../src/storage/sqlite_local_store.ts'
import { EntryType } from '../../../src/types.ts'
import type { StoredEntry } from '../../../src/types.ts'

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Host drill did not acquire a TCP port'))
        return
      }

      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function request(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpGet(url, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
      })
    })
    outgoing.once('error', reject)
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

class MonitoredTagsFailureStore extends MemoryStore {
  readonly saves: StoredEntry[][] = []
  monitoredTagsFailure: Error | null = null
  monitoredTagsCalls = 0

  override async save(entries: StoredEntry[]): Promise<void> {
    this.saves.push(entries)
    await super.save(entries)
  }

  override async monitoredTags(): Promise<string[]> {
    this.monitoredTagsCalls++
    if (this.monitoredTagsFailure !== null) {
      throw this.monitoredTagsFailure
    }

    return super.monitoredTags()
  }
}

test.group('Recorder | failure drills', (group) => {
  group.each.teardown(() => setInternalLogger(null))

  test('keep the host serving when sqlite closes immediately before flush', async ({
    assert,
    cleanup,
  }) => {
    const directory = mkdtempSync(join(tmpdir(), 'periscope-failure-drill-'))
    const store = new SqliteLocalStore({ path: join(directory, 'periscope.sqlite') })
    const recorder = new Recorder({
      config: defineConfig({ storage: { driver: 'sqlite-local' } }),
      store,
    })
    const internalLogs: Array<{ label: string; error: unknown }> = []
    setInternalLogger((label, error) => internalLogs.push({ label, error }))

    await store.close()
    cleanup(() => rmSync(directory, { recursive: true, force: true }))

    const server = createServer(async (_request, response) => {
      const context = BatchScope.createContext('request')
      BatchScope.runWith(context, () => {
        recorder.record(IncomingEntry.make(EntryType.REQUEST, { method: 'GET', url: '/health' }))
      })

      await recorder.flush(context)
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('host-ok')
    })
    const url = await listen(server)
    cleanup(() => close(server))

    const response = await request(`${url}/health`)

    assert.equal(response.status, 200)
    assert.equal(response.body, 'host-ok')
    assert.lengthOf(internalLogs, 1)
    assert.equal(internalLogs[0].label, 'periscope.recorder.flush')
    assert.instanceOf(internalLogs[0].error, Error)
  })

  test('reuse last-known monitored tags when a later read fails', async ({ assert }) => {
    const originalHrtime = process.hrtime.bigint
    let monotonic = 1_000_000_000n
    Object.defineProperty(process.hrtime, 'bigint', { value: () => monotonic })
    setInternalLogger(() => {})

    try {
      const store = new MonitoredTagsFailureStore()
      await store.monitorTag('tenant:42')
      const recorder = new Recorder({
        config: defineConfig({ recording: { sampleRate: 0 } }),
        store,
      })
      const flushBatch = async (tag?: string) => {
        const context = BatchScope.createContext('request')
        BatchScope.runWith(context, () => {
          const entry = IncomingEntry.make(EntryType.REQUEST, { tag: tag ?? null })
          recorder.record(tag === undefined ? entry : entry.withTags(tag))
        })
        await recorder.flush(context)
        return context
      }

      await flushBatch('tenant:42')
      monotonic += BigInt(MONITORED_TAGS_CACHE_TTL_MS) * 1_000_000n + 1n
      store.monitoredTagsFailure = new Error('tags unavailable')

      const formerlyMonitored = await flushBatch('tenant:42')
      const unmonitored = await flushBatch()

      assert.equal(formerlyMonitored.retention, 'kept')
      assert.equal(unmonitored.retention, 'dropped')
      assert.lengthOf(store.saves, 2)
      assert.equal(store.monitoredTagsCalls, 3)
    } finally {
      Object.defineProperty(process.hrtime, 'bigint', { value: originalHrtime })
    }
  })

  test('fail open when monitored tags have never been read successfully', async ({ assert }) => {
    const store = new MonitoredTagsFailureStore()
    store.monitoredTagsFailure = new Error('tags unavailable')
    setInternalLogger(() => {})
    const recorder = new Recorder({
      config: defineConfig({ recording: { sampleRate: 0 } }),
      store,
    })
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      recorder.record(IncomingEntry.make(EntryType.REQUEST, { path: '/first-read-failure' }))
    })
    await recorder.flush(context)

    assert.equal(context.retention, 'kept')
    assert.lengthOf(store.saves, 1)
    assert.equal(store.monitoredTagsCalls, 1)
  })
})
