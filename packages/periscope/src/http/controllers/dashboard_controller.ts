/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import { isRecordingEnabled } from '../../define_config.ts'
import { Flag } from '../../types.ts'
import type { PeriscopeStore, ResolvedPeriscopeConfig } from '../../types.ts'
import type { DashboardEnvironment } from '../middleware/authorize.ts'

const ALLOWED_FLAGS: Record<string, true> = {
  [Flag.PAUSED]: true,
  [Flag.DUMP_OPEN]: true,
}

export class DashboardController {
  constructor(
    private readonly store: PeriscopeStore,
    private readonly config: ResolvedPeriscopeConfig,
    private readonly environment: DashboardEnvironment
  ) {}

  async counts() {
    return { data: await this.store.counts() }
  }

  async status() {
    const enabled = isRecordingEnabled(this.config, {
      nodeEnv: this.environment.nodeEnv,
      periscopeEnabled: this.environment.periscopeEnabled(),
    })

    return {
      enabled,
      paused: (await this.store.getFlag(Flag.PAUSED)) !== null,
      path: this.config.dashboard.path,
      nPlusOneThreshold: this.config.dashboard.nPlusOneThreshold,
    }
  }

  async setFlag({ params, request, response }: HttpContext) {
    if (!Object.hasOwn(ALLOWED_FLAGS, params.name)) {
      response.notFound()
      return
    }

    const value = request.input('value')
    await this.store.setFlag(params.name, value === undefined ? '1' : String(value))
    response.noContent()
  }

  async deleteFlag({ params, response }: HttpContext) {
    if (!Object.hasOwn(ALLOWED_FLAGS, params.name)) {
      response.notFound()
      return
    }

    await this.store.deleteFlag(params.name)
    response.noContent()
  }

  async clear({ response }: HttpContext) {
    await this.store.clear()
    response.noContent()
  }
}
