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
 * The server middleware stack runs on every HTTP request, including missing routes. Periscope
 * must open the request batch before anything downstream runs. First place is load-bearing:
 * moving it behind container bindings would leave that work outside the scope that correlates
 * the request, its queries, logs, events, and exceptions.
 */
server.use([
  () => import('@rikology/adonisjs-periscope/middleware/request_watcher'),
  () => import('#middleware/container_bindings_middleware'),
])

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
