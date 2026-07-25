/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { ApplicationService } from '@adonisjs/core/types'

/**
 * The Periscope service provider, registered by an application under `adonisrc.ts#providers`.
 *
 * Phase 0 deliberately ships genuinely-empty lifecycle methods. No application registers this
 * provider yet — the playground gets wired up in Phase 1, once `register` binds something worth
 * resolving — and when it does, nothing here may throw. Later phases fill them in:
 *
 * - `register`  — bind the recorder, store driver and config (P1.3, P1.5, P2.x).
 * - `boot`      — resolve config, construct the store, attach watchers (P3.x — P6.x).
 * - `start`     — register the dashboard routes and API (P4.x).
 * - `ready`     — start the ambient batch rotation timer (P1.2).
 * - `shutdown`  — flush the ambient batch and close the store (P1.2, P2.x).
 */
export default class PeriscopeProvider {
  constructor(protected app: ApplicationService) {}

  register() {}

  async boot() {}

  async start() {}

  async ready() {}

  async shutdown() {}
}
