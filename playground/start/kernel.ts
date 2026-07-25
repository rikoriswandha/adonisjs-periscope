/*
|--------------------------------------------------------------------------
| HTTP kernel file
|--------------------------------------------------------------------------
|
| The HTTP kernel file is used to register the middleware with the server
| or the router.
|
*/

import emitter from '@adonisjs/core/services/emitter'
import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

import FanoutRequested from '#events/fanout_requested'

/**
 * The error handler is used to convert an exception
 * to a HTTP response.
 */
server.errorHandler(() => import('#exceptions/handler'))

/**
 * The server middleware stack runs middleware on all the HTTP
 * requests, even if there is no route registered for
 * the request URL.
 */
server.use([() => import('#middleware/container_bindings_middleware')])

/**
 * The router middleware stack runs middleware on all the HTTP
 * requests with a registered route.
 */
router.use([
  () => import('@adonisjs/core/bodyparser_middleware'),
  () => import('@adonisjs/session/session_middleware'),
  () => import('@adonisjs/shield/shield_middleware'),
])

/**
 * Event listeners.
 *
 * A full app would preload a dedicated "start/events.ts" file for this. The
 * playground has exactly one listener, so it is registered here to keep the
 * preload list down to routes + kernel.
 */
emitter.listen(FanoutRequested, [() => import('#listeners/log_fanout')])
