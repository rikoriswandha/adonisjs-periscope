/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { ApplicationService } from '@adonisjs/core/types'

import type { ResolvedPeriscopeConfig } from '../src/types.ts'

/**
 * Maintenance commands run in a process separate from the application they manage. An in-memory
 * store in that process can never contain the application's entries or flags, so reporting success
 * would be misleading.
 */
export function ensureDurableStorage(app: ApplicationService): void {
  const config = app.config.get<ResolvedPeriscopeConfig>('periscope')

  if (config.storage.driver === 'memory') {
    throw new Error(
      'Periscope commands cannot use storage.driver "memory" because Ace runs in a separate ' +
        'process. Set storage.driver to "sqlite-local" or "database" in config/periscope.ts and ' +
        'retry.'
    )
  }
}
