/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

import { isRecordingEnabled } from '../../define_config.ts'
import type { Recorder } from '../../recorder/recorder.ts'
import type { ResolvedPeriscopeConfig } from '../../types.ts'

export type DashboardEnvironment = {
  nodeEnv: string
  periscopeEnabled: () => string | undefined
}

/**
 * Build the one middleware shared by every dashboard route. The environment gate intentionally
 * runs before the application policy so a disabled production installation leaks no endpoint,
 * and the entire chain runs muted so authorization and dashboard storage reads cannot record
 * themselves.
 */
export function createDashboardAuthorize(
  config: ResolvedPeriscopeConfig,
  recorder: Recorder,
  environment: DashboardEnvironment
) {
  return (ctx: HttpContext, next: NextFn) =>
    recorder.mute(async () => {
      if (
        !isRecordingEnabled(config, {
          nodeEnv: environment.nodeEnv,
          periscopeEnabled: environment.periscopeEnabled(),
        })
      ) {
        ctx.response.notFound()
        return
      }

      if (!(await config.dashboard.authorize(ctx))) {
        ctx.response.forbidden()
        return
      }

      return next()
    })
}
