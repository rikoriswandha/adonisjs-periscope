/*
 * periscope
 *
 * Phase 8 failure-mode drills that cross component boundaries. Unit tests for the individual
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
import { Recorder } from '../../../src/recorder/recorder.ts'
import { setInternalLogger } from '../../../src/safeguard.ts'
import { SqliteLocalStore } from '../../../src/storage/sqlite_local_store.ts'
import { EntryType } from '../../../src/types.ts'

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

test.group('Recorder | Phase 8 failure drills', (group) => {
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
})
