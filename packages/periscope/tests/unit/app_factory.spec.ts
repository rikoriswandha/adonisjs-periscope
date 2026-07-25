/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'
import { Emitter } from '@adonisjs/core/events'

import { createApp } from '../helpers/app_factory.ts'

test.group('App factory', () => {
  test('boot a throwaway application', async ({ assert }) => {
    const { app } = await createApp()

    assert.isTrue(app.isBooted)
    assert.instanceOf(app.appRoot, URL)
    assert.isTrue(app.appRoot.pathname.endsWith('/tests/tmp/'))
  })

  test('bind the in-memory emitter into the container', async ({ assert }) => {
    const { app, emitter } = await createApp()

    assert.instanceOf(emitter, Emitter)
    assert.strictEqual(await app.container.make('emitter'), emitter)
  })

  test('seed config values', async ({ assert }) => {
    const { app } = await createApp({ config: { periscope: { enabled: false } } })

    assert.isFalse(app.config.get('periscope.enabled'))
  })
})
