/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

const UNSAFE_METHODS: Record<string, true> = {
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
}

export const PERISCOPE_REQUEST_HEADER = 'x-periscope-request'
export const PERISCOPE_REQUEST_HEADER_VALUE = 'dashboard'

/**
 * Require a header that browser forms cannot submit and reject requests that the browser identifies
 * as coming from another origin. Shield still performs its own token validation when installed;
 * this check protects applications that do not use Shield (or have its CSRF guard disabled).
 */
export function protectDashboardMutation(ctx: HttpContext, next: NextFn) {
  if (UNSAFE_METHODS[ctx.request.method()] !== true) {
    return next()
  }

  const fetchSite = ctx.request.header('sec-fetch-site')
  const fromDashboard =
    ctx.request.header(PERISCOPE_REQUEST_HEADER) === PERISCOPE_REQUEST_HEADER_VALUE

  if (!fromDashboard || (fetchSite !== undefined && fetchSite !== 'same-origin')) {
    ctx.response.forbidden()
    return
  }

  return next()
}
