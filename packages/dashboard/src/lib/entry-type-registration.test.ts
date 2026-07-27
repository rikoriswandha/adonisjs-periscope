import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertUniqueEntryTypeMetadata,
  registerEntryType,
  type EntryTypeMetadataContract,
} from './entry-type-registration.ts'

const icon = () => null

function metadata(type: string, path = type): EntryTypeMetadataContract {
  return {
    type,
    path,
    label: type,
    group: 'Application',
    icon,
    load: async () => ({ heading: type }),
  }
}

test('registerEntryType retains frozen navigation metadata without resolving its implementation', async () => {
  let loads = 0
  const registration = registerEntryType({
    ...metadata('mail'),
    load: async () => {
      loads += 1
      return { heading: 'Mail activity' }
    },
  })

  assert.equal(registration.label, 'mail')
  assert.equal(loads, 0)
  assert.equal(Object.isFrozen(registration), true)
  assert.deepEqual(await registration.load(), { heading: 'Mail activity' })
  assert.equal(loads, 1)
})

test('registerEntryType rejects metadata without an icon or lazy implementation loader', () => {
  assert.throws(() => registerEntryType({ ...metadata('cache'), icon: null }), /icon/)
  assert.throws(
    () => registerEntryType({ ...metadata('gate'), load: null as never }),
    /lazy implementation loader/
  )
})

test('registry validation rejects duplicate entry types and paths', () => {
  assert.throws(
    () => assertUniqueEntryTypeMetadata([metadata('mail'), metadata('mail', 'other')]),
    /Duplicate entry type registration: mail/
  )
  assert.throws(
    () =>
      assertUniqueEntryTypeMetadata([metadata('mail', 'activity'), metadata('cache', 'activity')]),
    /Duplicate entry type path: activity/
  )
})
