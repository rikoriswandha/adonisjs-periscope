/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'

import { createStore } from '../../../src/storage/resolve.ts'
import { defineConfig } from '../../../src/define_config.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { PeriscopeStorageError } from '../../../src/errors.ts'
import { makeStoredEntry } from '../../storage/contract.ts'
import type { StorageDriverName } from '../../../src/types.ts'

/**
 * Driver names that `defineConfig` accepts but `createStore` cannot build yet. They land in P2.1
 * and P2.2; until then every one of them must fail loudly.
 */
const UNIMPLEMENTED_DRIVERS: StorageDriverName[] = ['sqlite-local', 'database']

test.group('createStore', () => {
  test('build a memory store for the memory driver', ({ assert }) => {
    const store = createStore(defineConfig({ storage: { driver: 'memory' } }))

    assert.instanceOf(store, MemoryStore)
  })

  test('pass storage.maxEntries through to the memory store', async ({ assert }) => {
    const store = createStore(defineConfig({ storage: { driver: 'memory', maxEntries: 2 } }))
    const entries = [makeStoredEntry(), makeStoredEntry(), makeStoredEntry()]

    await store.save(entries)

    /**
     * The ceiling is private, so it is asserted the only way that matters to a user: the ring
     * buffer evicts at the configured size rather than at the driver's own 10 000 default. A
     * `createStore` that dropped the option on the floor would silently give every application
     * an unbounded-looking buffer.
     */
    const page = await store.list()

    assert.deepEqual(
      page.data.map((entry) => entry.uuid),
      [entries[2].uuid, entries[1].uuid]
    )
  })

  for (const driver of UNIMPLEMENTED_DRIVERS) {
    test(`refuse to build the ${driver} driver until it exists`, ({ assert }) => {
      const config = defineConfig({ storage: { driver } })

      /**
       * The driver name has to appear in the message. This is the guard against the failure mode
       * that would be genuinely expensive: a Phase 2 driver whose config wiring is forgotten,
       * quietly downgrading a production application to an in-process ring buffer and losing
       * every entry on restart. A named, thrown error cannot be mistaken for that.
       */
      assert.throws(() => createStore(config), PeriscopeStorageError, driver)
    })
  }
})
