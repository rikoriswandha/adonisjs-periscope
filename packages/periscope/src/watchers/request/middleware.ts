/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { NextFn } from '@adonisjs/core/types/http'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Implemented in Phase 3 (P3.2 — RequestWatcher). Phase 0 ships the module so the package
 * `exports` map resolves and `npm run build` produces every declared entry point.
 *
 * The middleware must be registered first in the server middleware stack: P3.2 opens a
 * `BatchScope` around `next()` here, so anything the rest of the stack records is correlated
 * to the request batch. Until then it is a transparent pass-through, which is exactly what a
 * host application registering it in Phase 0 should observe.
 */
export default class RequestWatcherMiddleware {
  handle(_ctx: HttpContext, next: NextFn) {
    return next()
  }
}
