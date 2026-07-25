/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { MemoryStore } from './memory_store.ts'
import { PeriscopeStorageError } from '../errors.ts'
import type { PeriscopeStore, ResolvedPeriscopeConfig } from '../types.ts'

/**
 * Turns the configured `storage.driver` name into a live store.
 *
 * The provider calls this once at boot. Drivers are constructed eagerly rather than lazily so a
 * broken storage setup surfaces while the application is starting, rather than on the first
 * request that happens to record something.
 */
export function createStore(config: ResolvedPeriscopeConfig): PeriscopeStore {
  switch (config.storage.driver) {
    case 'memory':
      return new MemoryStore({ maxEntries: config.storage.maxEntries })

    /**
     * P2.1 and P2.2 add these. Until then, naming one in `config/periscope.ts` configures a
     * driver that does not exist yet, which is worth an explicit error rather than a silent
     * fallback to `memory`: an application that asked for durable storage and quietly got a ring
     * buffer would end up debugging the wrong problem.
     */
    case 'sqlite-local':
    case 'database':
      throw new PeriscopeStorageError(
        `The Periscope "${config.storage.driver}" storage driver is not implemented yet ` +
          '(it lands in Phase 2). Set storage.driver to "memory" in config/periscope.ts.'
      )

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
