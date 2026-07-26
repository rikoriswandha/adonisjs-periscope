import assert from 'node:assert/strict'
import test from 'node:test'

import { createDumpOpenLeaseFlag, DUMP_OPEN_LEASE_FLAG } from './dump-open-lease.ts'

test('keeps one safe lease name stable for the lifetime of the tab module', () => {
  const firstRead = DUMP_OPEN_LEASE_FLAG
  const secondRead = DUMP_OPEN_LEASE_FLAG

  assert.equal(firstRead, secondRead)
  assert.match(firstRead, /^dump-open:[A-Za-z0-9_-]{1,128}$/)
})

test('creates a separate safe lease name for each dashboard tab id', () => {
  const first = createDumpOpenLeaseFlag('67ff2064-f8de-40bc-a18f-de9827b8480c')
  const second = createDumpOpenLeaseFlag('cf4ee5cf-7c8b-453a-b4a3-b244fdc75a71')

  assert.equal(first, 'dump-open:67ff2064-f8de-40bc-a18f-de9827b8480c')
  assert.equal(second, 'dump-open:cf4ee5cf-7c8b-453a-b4a3-b244fdc75a71')
  assert.notEqual(first, second)
})

test('rejects client ids that could escape the dump-open flag namespace', () => {
  for (const id of ['', '*', 'tab:other', 'tab/other', 'tab%other', 'a'.repeat(129)]) {
    assert.throws(() => createDumpOpenLeaseFlag(id), /Invalid dump-open client id/)
  }
})
