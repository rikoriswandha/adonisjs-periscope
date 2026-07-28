/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| This file contains only the routes needed for observable end-to-end fixtures.
|
| Controllers are lazily imported so the dev-server can hot-replace them.
|
*/

import router from '@adonisjs/core/services/router'

const ProbesController = () => import('#controllers/probes_controller')
const EchoController = () => import('#controllers/echo_controller')
const FanoutController = () => import('#controllers/fanout_controller')
const SessionController = () => import('#controllers/session_controller')
const Wave2Controller = () => import('#controllers/wave2_controller')
const ShowcaseController = () => import('#controllers/showcase_controller')

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
 * Exercises every watcher backed by an installed playground integration.
 */
router.get('/watchers', [Wave2Controller, 'handle']).as('watchers')

/**
 * Exercises the opt-in watchers: session, redis command traces and job/schedule lifecycles.
 */
router.get('/showcase', [ShowcaseController, 'handle']).as('showcase')

/**
 * Auth-less session stub.
 */
router.post('/login', [SessionController, 'login']).as('login')
router.get('/me', [SessionController, 'me']).as('me')
