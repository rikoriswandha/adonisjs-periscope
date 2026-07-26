/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { MemoryStore } from './memory_store.ts'
import { DatabaseStore } from './database_store.ts'
import { PeriscopeStorageError } from '../errors.ts'
import { SqliteLocalStore } from './sqlite_local_store.ts'
import type { PeriscopeStore, ResolvedPeriscopeConfig } from '../types.ts'

/**
 * `Database` is imported for its type only. `@adonisjs/lucid` is an *optional* peer dependency,
 * so the emitted JavaScript must not carry an import of it: an application on the `memory` or
 * `sqlite-local` driver has every right not to have Lucid installed at all.
 */
import type { Database } from '@adonisjs/lucid/database'

/**
 * What a driver may need from the host application, narrowed to the two things Periscope
 * actually asks for. Passing this instead of the `ApplicationService` keeps `createStore`
 * testable without booting an application, and keeps container knowledge in the provider.
 */
export type StoreContext = {
  /** Resolves a path inside the application's tmp directory (`app.tmpPath()`). */
  tmpPath(...paths: string[]): string

  /**
   * Resolves the host application's Lucid database service. Absent when Lucid is not installed
   * or its provider is not registered — which is exactly the condition the `database` driver
   * has to report as a helpful error rather than a `TypeError`.
   */
  database?: () => Promise<Database>
}

/**
 * Turns the configured `storage.driver` name into a live store.
 *
 * The provider calls this once at boot. Drivers are constructed eagerly rather than lazily so a
 * broken storage setup surfaces while the application is starting, rather than on the first
 * request that happens to record something. That is also why this is `async` and awaited during
 * boot: resolving the Lucid service is a container `make()`, and deferring it to the first write
 * would turn a missing provider into a swallowed flush failure instead of a boot error.
 */
export async function createStore(
  config: ResolvedPeriscopeConfig,
  context: StoreContext
): Promise<PeriscopeStore> {
  switch (config.storage.driver) {
    case 'memory':
      return new MemoryStore({ maxEntries: config.storage.maxEntries })

    /**
     * A file of Periscope's own under `tmp/`, deliberately not in the application's database:
     * debugging data is disposable, and `rm tmp/periscope.sqlite` has to remain a safe way to
     * start over.
     */
    case 'sqlite-local':
      return new SqliteLocalStore({ path: context.tmpPath('periscope.sqlite') })

    case 'database': {
      /**
       * The `database` driver borrows the application's own Lucid connection, so it can only be
       * built when the host actually has one. Lucid is an optional peer dependency and its
       * provider is registered by the application, so both halves can legitimately be missing —
       * and the resulting failure has to name the fix rather than surface as an `undefined is
       * not a function` somewhere inside boot.
       */
      if (context.database === undefined) {
        throw new PeriscopeStorageError(
          'The Periscope "database" storage driver needs the AdonisJS Lucid database service, ' +
            'and this application does not provide one. Install @adonisjs/lucid and register ' +
            '@adonisjs/lucid/database_provider in adonisrc.ts, or set storage.driver to ' +
            '"sqlite-local" in config/periscope.ts to keep Periscope in a file of its own.'
        )
      }

      const db = await context.database()
      const connection = config.storage.connection

      /**
       * A connection name that Lucid does not know is the same class of mistake, one typo
       * further along. `DatabaseStore` resolves its client per call, so an unknown name would
       * not fail here at all — it would fail on the first flush, inside the recorder's swallowed
       * error handling, and the only symptom anybody would ever see is a dashboard that stays
       * empty. Checking it while the store is being built is the whole reason the store is built
       * eagerly.
       */
      if (connection !== undefined && !db.manager.has(connection)) {
        const known = [...db.manager.connections.keys()]

        throw new PeriscopeStorageError(
          `Unknown Periscope database connection ${JSON.stringify(connection)}. ` +
            `The application defines: ${known.join(', ')}. ` +
            'Set storage.connection in config/periscope.ts to one of those names, matching a ' +
            'key of the connections object in config/database.ts.'
        )
      }

      return new DatabaseStore({ db, connection })
    }

    default: {
      /**
       * `defineConfig` rejects unknown driver names, so reaching here means the config object
       * bypassed it. The `never` binding makes adding a driver to `StorageDriverName` without
       * handling it here a compile error.
       */
      const driver: never = config.storage.driver
      throw new PeriscopeStorageError(
        `Unknown Periscope storage driver ${JSON.stringify(driver)}. ` +
          'Expected one of: memory, sqlite-local, database.'
      )
    }
  }
}
