/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getActiveTest, test } from '@japa/runner'
import { AppFactory } from '@adonisjs/core/factories/app'
import { EmitterFactory } from '@adonisjs/core/factories/events'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Database } from '@adonisjs/lucid/database'

import { createStore } from '../../../src/storage/resolve.ts'
import { defineConfig } from '../../../src/define_config.ts'
import { DatabaseStore } from '../../../src/storage/database_store.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { SqliteLocalStore } from '../../../src/storage/sqlite_local_store.ts'
import { PeriscopeStorageError } from '../../../src/errors.ts'
import { makeStoredEntry } from '../../storage/contract.ts'
import type { DatabaseConfig } from '@adonisjs/lucid/types/database'
import type { PeriscopeStore, ResolvedPeriscopeConfig } from '../../../src/types.ts'
import type { StoreContext } from '../../../src/storage/resolve.ts'

/**
 * A throwaway directory standing in for `app.tmpPath()`, plus a store context over it. The
 * directory is removed during test cleanup together with whatever the driver wrote into it: a
 * leaked sqlite file would have the next run of this suite reading a database it did not create.
 */
async function createContext(): Promise<StoreContext & { root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'periscope-resolve-'))

  getActiveTest()?.cleanup(async () => {
    await rm(root, { recursive: true, force: true })
  })

  return { root, tmpPath: (...paths: string[]) => join(root, ...paths) }
}

/**
 * Closes the resolved store once the test is over. Every driver but `memory` holds an
 * operating-system handle, and `bin/test.ts` runs with `forceExit: true`, which would tear a
 * leaked one down along with the process and report nothing at all. Closing explicitly is what
 * turns a handle the driver failed to release into a failing cleanup rather than silence.
 */
function closeAfterTest(store: PeriscopeStore): void {
  getActiveTest()?.cleanup(async () => {
    await store.close()
  })
}

/**
 * A real Lucid `Database`, on a file in the throwaway directory rather than a stub object.
 *
 * A hand-rolled fake would pass whatever `DatabaseStore` happens to do in its constructor today
 * and break the moment it does something else, which is precisely the coupling this test exists
 * to avoid: what is under test is that resolution hands the driver the application's own service
 * and the configured connection name, not how the driver uses them.
 */
function createDatabase(root: string): Database {
  const app = new AppFactory().create(new URL('../../tmp/', import.meta.url), () => {})
  const emitter = new EmitterFactory().create(app)
  const logger = new LoggerFactory().create()

  const config: DatabaseConfig = {
    connection: 'periscope',
    connections: {
      periscope: {
        client: 'better-sqlite3',
        connection: { filename: join(root, 'lucid.sqlite') },
        useNullAsDefault: true,
      },
    },
  }

  const db = new Database(config, logger, emitter)

  getActiveTest()?.cleanup(async () => {
    await db.manager.closeAll()
  })

  return db
}

test.group('createStore | memory', () => {
  test('build a memory store for the memory driver', async ({ assert }) => {
    const context = await createContext()
    const store = await createStore(defineConfig({ storage: { driver: 'memory' } }), context)

    closeAfterTest(store)

    assert.instanceOf(store, MemoryStore)
  })

  test('pass storage.maxEntries through to the memory store', async ({ assert }) => {
    const context = await createContext()
    const store = await createStore(
      defineConfig({ storage: { driver: 'memory', maxEntries: 2 } }),
      context
    )

    closeAfterTest(store)

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
})

test.group('createStore | sqlite-local', () => {
  test('build a sqlite store rooted in the application tmp directory', async ({ assert }) => {
    const context = await createContext()
    const store = await createStore(defineConfig({ storage: { driver: 'sqlite-local' } }), context)

    closeAfterTest(store)

    assert.instanceOf(store, SqliteLocalStore)

    /**
     * The file name is part of the contract rather than an implementation detail: the shipped
     * config template, the playground demo and every "start over with `rm tmp/periscope.sqlite`"
     * instruction name it. A driver pointed somewhere else leaves a user staring at an empty
     * dashboard with a perfectly good database file on disk.
     */
    assert.isTrue(existsSync(join(context.root, 'periscope.sqlite')))
  })

  test('round-trip an entry through the file the driver opened', async ({ assert }) => {
    const context = await createContext()
    const store = await createStore(defineConfig({ storage: { driver: 'sqlite-local' } }), context)

    closeAfterTest(store)

    const entry = makeStoredEntry()
    await store.save([entry])

    /**
     * Resolution is only worth anything if what comes back is a *working* store. A driver handed
     * the wrong path, or one whose schema bootstrap never ran, is instanceof-correct and useless.
     */
    const found = await store.find(entry.uuid)

    assert.equal(found?.uuid, entry.uuid)
  })
})

test.group('createStore | database', () => {
  test('build a database store from the lucid service the context provides', async ({ assert }) => {
    const context = await createContext()
    const db = createDatabase(context.root)

    const store = await createStore(
      defineConfig({ storage: { driver: 'database', connection: 'periscope' } }),
      { ...context, database: async () => db }
    )

    closeAfterTest(store)

    assert.instanceOf(store, DatabaseStore)
  })

  test('refuse a connection name the lucid manager does not know', async ({ assert }) => {
    const context = await createContext()
    const db = createDatabase(context.root)

    const config = defineConfig({ storage: { driver: 'database', connection: 'periscpoe' } })
    const error = await createStore(config, { ...context, database: async () => db }).catch(
      (reason: unknown) => reason
    )

    /**
     * `DatabaseStore` resolves its client once per call, so a typo costs nothing here and
     * everything later: the first flush fails inside the recorder's swallowed error handling and
     * the only symptom is a dashboard that never fills. Naming the connections that do exist is
     * half the fix — "periscpoe" beside "periscope" reads as a typo at a glance.
     */
    assert.instanceOf(error, PeriscopeStorageError)
    assert.include((error as Error).message, 'periscpoe')
    assert.include((error as Error).message, 'periscope')
    assert.include((error as Error).message, 'config/database.ts')
  })

  test('refuse the database driver when the application has no lucid service', async ({
    assert,
  }) => {
    const context = await createContext()
    const config = defineConfig({ storage: { driver: 'database' } })

    const error = await createStore(config, context).catch((reason: unknown) => reason)

    /**
     * The wording is the feature here. Without a Lucid service the alternative is a `TypeError`
     * thrown from somewhere inside boot, which says nothing about the config line that caused it,
     * so the message has to name the driver, the package to install and the driver to switch to
     * instead.
     */
    assert.instanceOf(error, PeriscopeStorageError)
    assert.include((error as Error).message, 'database')
    assert.include((error as Error).message, '@adonisjs/lucid')
    assert.include((error as Error).message, 'sqlite-local')
  })

  test('never open a lucid connection for the other drivers', async ({ assert }) => {
    const context = await createContext()
    let resolved = 0

    const store = await createStore(defineConfig({ storage: { driver: 'memory' } }), {
      ...context,
      database: async () => {
        resolved += 1
        return createDatabase(context.root)
      },
    })

    closeAfterTest(store)

    /**
     * Resolving `lucid.db` boots a connection pool. An application on `memory` or `sqlite-local`
     * must not pay for one just because Lucid happens to be installed.
     */
    assert.equal(resolved, 0)
  })
})

test.group('createStore | unknown drivers', () => {
  test('refuse a driver name that bypassed defineConfig', async ({ assert }) => {
    const context = await createContext()

    /**
     * `defineConfig` rejects unknown names, so this is only reachable from a config object that
     * skipped validation — a JavaScript application, or a hand-written literal. Falling back to
     * `memory` would quietly downgrade an application that asked for durable storage into one
     * that loses every entry on restart, so it throws instead.
     */
    const config = {
      ...defineConfig({}),
      storage: { driver: 'postgres', maxEntries: 10 },
    } as unknown as ResolvedPeriscopeConfig

    const error = await createStore(config, context).catch((reason: unknown) => reason)

    assert.instanceOf(error, PeriscopeStorageError)
    assert.include((error as Error).message, 'postgres')
    assert.include((error as Error).message, 'memory, sqlite-local, database')
  })
})
