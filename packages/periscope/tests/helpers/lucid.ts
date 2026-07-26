/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Real Lucid connections for the `database` driver's tests.
 *
 * The driver under test talks to a `Database` instance and nothing else, so the tests give it a
 * real one — no stub client, no in-memory fake. `Database` needs only a config object, a logger
 * and an emitter, all three of which `@adonisjs/core`'s factories produce without booting an
 * application, so the whole harness is thirty lines and exercises the same knex compilers a real
 * application would.
 *
 * Two connections are offered: `better-sqlite3` against a throwaway file, which always runs, and
 * `pg` against `PERISCOPE_PG_URL`, which runs wherever a postgres is reachable (CI provides one).
 * Both are opened once per process and memoised — a fresh pool per test would dominate the suite's
 * runtime and, on postgres, would spend most of it on TCP handshakes.
 *
 * Schema creation goes through `src/storage/database_schema.ts`, the same function the published
 * migration stub calls. That is the point of the shared module: these tests prove the driver
 * against the exact DDL an application will run, so the two cannot pass here and diverge there.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppFactory } from '@adonisjs/core/factories/app'
import { EmitterFactory } from '@adonisjs/core/factories/events'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Database } from '@adonisjs/lucid/database'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'

import { createPeriscopeTables, dropPeriscopeTables } from '../../src/storage/database_schema.ts'

/**
 * Postgres connection string, or `undefined` when no server was provided. Specs branch on this to
 * decide whether to register or skip their postgres group.
 */
export const POSTGRES_URL = process.env.PERISCOPE_PG_URL

/**
 * Postgres schema this process owns.
 *
 * The sqlite half of these tests gets a private file per run; the postgres half shares whatever
 * server `PERISCOPE_PG_URL` points at, and `reset()` drops and recreates tables. Two runs against
 * one server — a developer re-running the suite while an agent's run is still finishing, two CI
 * jobs pointed at the same box — would then drop each other's tables mid-test and fail in ways
 * that never reproduce. A per-process schema makes the two runs invisible to each other; the
 * connection's `searchPath` is what makes every unqualified table name land in it.
 */
const POSTGRES_SCHEMA = `periscope_test_${process.pid}`

/**
 * The connections this helper can build. `sqlite` is always available; `postgres` needs
 * {@link POSTGRES_URL}.
 */
export type TestConnection = 'sqlite' | 'postgres'

export type TestDatabase = {
  db: Database

  /**
   * The query client for the single connection this database was built with.
   */
  client: QueryClientContract

  /**
   * Drop and recreate all four Periscope tables. Cheaper than it sounds on both dialects, and it
   * leaves nothing behind — no leftover rows, no leftover monitored tags, no leftover flags — so
   * a test can never observe the one before it.
   */
  reset: () => Promise<void>
}

/**
 * Opened databases, keyed by connection. Memoised as promises rather than as values so two
 * concurrent first calls cannot each open a pool.
 */
const databases = new Map<TestConnection, Promise<TestDatabase>>()

/**
 * Temporary directories holding the SQLite files, removed by {@link closeTestDatabases}.
 */
const temporaryDirectories: string[] = []

async function openDatabase(connection: TestConnection): Promise<TestDatabase> {
  /*
   * `AppFactory` is only here because `EmitterFactory#create` wants an application to resolve
   * listeners against. Nothing in these tests emits or listens, and the app is never booted.
   */
  const app = new AppFactory().create(new URL('../tmp/', import.meta.url), () => {})
  const emitter = new EmitterFactory().create(app)
  const logger = new LoggerFactory().create()

  let filename = ''

  if (connection === 'sqlite') {
    const directory = await mkdtemp(join(tmpdir(), 'periscope-lucid-'))
    temporaryDirectories.push(directory)
    filename = join(directory, 'periscope.sqlite')
  }

  if (connection === 'postgres' && POSTGRES_URL === undefined) {
    throw new Error(
      'PERISCOPE_PG_URL is not set; a postgres test database cannot be opened. ' +
        'Guard the call with the POSTGRES_URL export instead of reaching this line.'
    )
  }

  const db = new Database(
    {
      connection,
      connections: {
        /*
         * `debug: true` is what makes Lucid emit `db:query`. The EXPLAIN test reads the SQL the
         * driver actually sent off that event rather than rebuilding the query by hand, and the
         * flag has to live in the connection config because `Database#connection()` mints a
         * fresh query client per call — a `client.debug = true` set on one instance would never
         * be seen by the one the store resolves. Emission is gated on a listener existing, so
         * the rest of the suite pays nothing for it.
         */
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename },
          useNullAsDefault: true,
          debug: true,
          pool: {
            /*
             * Foreign keys off, deliberately. better-sqlite3 turns them on by default; SQLite
             * itself does not, and the connection this driver borrows belongs to the host, which
             * is free to leave them off — the driver is not allowed to change a pragma on
             * somebody else's connection. With the cascade available a driver that forgot to
             * delete its own tag rows would still pass the orphan assertions, so the harsher
             * setting is the one worth testing under.
             */
            afterCreate: (
              handle: { pragma: (source: string) => unknown },
              done: (error?: Error) => void
            ) => {
              handle.pragma('foreign_keys = OFF')
              done()
            },
          },
        },
        postgres: {
          client: 'pg',
          connection: POSTGRES_URL ?? '',
          searchPath: [POSTGRES_SCHEMA],
          debug: true,
        },
      },
    },
    logger,
    emitter
  )

  const client = db.connection(connection)

  if (connection === 'postgres') {
    await client.rawQuery(`create schema if not exists "${POSTGRES_SCHEMA}"`)
  }

  return {
    db,
    client,
    reset: async () => {
      await dropPeriscopeTables(client.schema)
      await createPeriscopeTables(client.schema)
    },
  }
}

/**
 * Open — or reuse — the database for one connection, with the Periscope tables already created.
 */
export async function useTestDatabase(connection: TestConnection): Promise<TestDatabase> {
  let opening = databases.get(connection)

  if (opening === undefined) {
    opening = openDatabase(connection)
    databases.set(connection, opening)
  }

  return opening
}

/**
 * Close every connection this helper opened and delete the SQLite files.
 *
 * Japa runs with `forceExit`, so a leaked pool would not hang the run — it would simply be killed.
 * Closing properly anyway is what makes a leak visible: an unclosed postgres pool that this
 * function does not know about keeps its server-side session alive, and a suite that opens one
 * per test would eventually hit `max_connections` rather than just running slowly.
 */
export async function closeTestDatabases(): Promise<void> {
  const opened = [...databases.values()]
  databases.clear()

  for (const opening of opened) {
    const database = await opening

    /*
     * Dropped rather than left behind: the schema is named after a pid, so a server that saw a
     * hundred runs would otherwise accumulate a hundred schemas full of stale entries.
     */
    if (database.client.dialect.name === 'postgres') {
      await database.client.rawQuery(`drop schema if exists "${POSTGRES_SCHEMA}" cascade`)
    }

    await database.db.manager.closeAll()
  }

  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
}
