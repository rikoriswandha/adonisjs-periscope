/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| Exactly the route set the implementation plan asks the fixture app for. Every
| later phase measures its "Done when" against these seven endpoints, so add
| routes here only when a phase needs a new observable behaviour.
|
| Controllers are lazily imported so the dev-server can hot-replace them.
|
*/

import router from '@adonisjs/core/services/router'

const ProbesController = () => import('#controllers/probes_controller')
const EchoController = () => import('#controllers/echo_controller')
const FanoutController = () => import('#controllers/fanout_controller')
const SessionController = () => import('#controllers/session_controller')

router.get('/', () => ({ hello: 'periscope playground' })).as('home')

/**
 * 200 with a real query.
 */
router.get('/ok', [ProbesController, 'ok']).as('ok')

/**
 * Sleeps 300ms and runs a deliberately expensive query.
 */
router.get('/slow', [ProbesController, 'slow']).as('slow')

/**
 * Always throws — 500.
 */
router.get('/boom', [ProbesController, 'boom']).as('boom')

/**
 * Validated payload carrying a "password" field, for redaction tests.
 */
router.post('/echo', [EchoController, 'handle']).as('echo')

/**
 * Emits a custom event, logs a warning and sends a fake mail.
 */
router.get('/fanout', [FanoutController, 'handle']).as('fanout')

/**
 * Auth-less session stub.
 */
router.post('/login', [SessionController, 'login']).as('login')
router.get('/me', [SessionController, 'me']).as('me')
