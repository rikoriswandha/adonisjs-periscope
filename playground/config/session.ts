import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig, stores } from '@adonisjs/session'

const sessionConfig = defineConfig({
  enabled: true,
  cookieName: 'adonis-session',
  clearWithBrowser: false,
  age: '2h',

  cookie: {
    path: '/',
    httpOnly: true,
    secure: app.inProduction,
    sameSite: 'lax',
  },

  /**
   * "memory" is always available without being listed in `stores` — the test
   * environment selects it via .env.test.
   */
  store: env.get('SESSION_DRIVER'),

  stores: {
    /**
     * Store session data inside encrypted cookies.
     */
    cookie: stores.cookie(),
  },
})

export default sessionConfig
