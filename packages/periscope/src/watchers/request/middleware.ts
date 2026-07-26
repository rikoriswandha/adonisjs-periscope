/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { NextFn } from '@adonisjs/core/types/http'
import type { HttpContext } from '@adonisjs/core/http'

import { getActiveWatcher } from '../active.ts'

/**
 * The middleware must be registered first in `server.use([...])`.
 *
 * The request watcher opens its `BatchScope` around `next()` here, so every query, log and event
 * produced by the rest of the server and router middleware stacks joins the same request batch.
 * Registering it later would leave earlier middleware activity outside the only scope that can
 * honestly correlate it.
 *
 * This host-wired class deliberately owns no state and resolves nothing from the container.
 * Applications import it long before Periscope has necessarily booted, so an empty active slot
 * must remain a transparent pass-through when recording is disabled, the request watcher is off,
 * or the registry has already shut down.
 */
export class RequestWatcherMiddleware {
  handle(ctx: HttpContext, next: NextFn) {
    const watcher = getActiveWatcher('request')

    if (watcher === null) {
      return next()
    }

    return watcher.handle(ctx, next)
  }
}

export default RequestWatcherMiddleware
