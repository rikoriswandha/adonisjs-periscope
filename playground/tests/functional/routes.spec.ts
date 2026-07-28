import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'

/**
 * This booted-app integration test pins the observable contract of every fixture route,
 * so Periscope changes can be checked immediately for changes to host behaviour.
 */
test.group('playground routes', (group) => {
  group.setup(() => testUtils.db().migrate())

  test('GET /ok responds 200 with the users read from the database', async ({ client, assert }) => {
    const response = await client.get('/ok')

    response.assertStatus(200)
    assert.isArray(response.body().users)
  })

  test('GET /slow responds 200 after sleeping and running the expensive query', async ({
    client,
    assert,
  }) => {
    const startedAt = Date.now()
    const response = await client.get('/slow')
    const elapsed = Date.now() - startedAt

    response.assertStatus(200)
    assert.equal(response.body().sleptMs, 300)
    assert.isAtLeast(elapsed, 300)
    assert.equal(response.body().result[0].rows_walked, response.body().iterations)
  })

  test('GET /boom responds 500', async ({ client }) => {
    const response = await client.get('/boom')

    response.assertStatus(500)
  })

  test('POST /echo validates and echoes the payload back, password included', async ({
    client,
    assert,
  }) => {
    const payload = {
      email: 'echo@periscope.test',
      password: 'super-secret',
      note: 'redact me downstream',
    }

    const response = await client.post('/echo').json(payload)

    response.assertStatus(200)
    assert.deepEqual(response.body().echoed, payload)
  })

  test('POST /echo rejects a payload missing the password', async ({ client, assert }) => {
    /**
     * `Accept: application/json` is load-bearing. With the session middleware in the stack,
     * AdonisJS content-negotiates a VineJS failure into a 302 redirect-back carrying flashed
     * errors for browser clients; only a JSON-accepting client gets the 422 + error body.
     */
    const response = await client
      .post('/echo')
      .json({ email: 'echo@periscope.test' })
      .accept('json')

    response.assertStatus(422)
    assert.deepInclude(response.body().errors[0], { field: 'password', rule: 'required' })
  })

  test('GET /fanout responds 200 after dispatching the event, logging and mailing', async ({
    client,
    assert,
  }) => {
    const response = await client.get('/fanout')

    response.assertStatus(200)
    assert.equal(response.body().event, 'FanoutRequested')
    assert.equal(response.body().logged, 'warn')
    assert.isString(response.body().messageId)
  })

  test('POST /login stores the user id in the session and GET /me reads it back', async ({
    client,
    assert,
  }) => {
    const credentials = { email: 'login@periscope.test', password: 'secret-password' }

    const login = await client.post('/login').json(credentials)
    login.assertStatus(200)

    const userId = login.body().userId
    assert.isNumber(userId)
    login.assertSession('userId', userId)

    const me = await client.get('/me').withSession({ userId })
    me.assertStatus(200)
    assert.equal(me.body().userId, userId)
  })

  test('POST /login rejects a wrong password for an existing user', async ({ client }) => {
    const credentials = { email: 'repeat@periscope.test', password: 'secret-password' }

    const created = await client.post('/login').json(credentials)
    created.assertStatus(200)

    const rejected = await client
      .post('/login')
      .json({ ...credentials, password: 'not-the-password' })
    rejected.assertStatus(401)
  })

  test('GET /me responds 401 without a session', async ({ client }) => {
    const response = await client.get('/me')

    response.assertStatus(401)
  })
})
