import { defineConfig } from '@adonisjs/shield'

const shieldConfig = defineConfig({
  csp: {
    enabled: false,
    directives: {},
    reportOnly: false,
  },

  /**
   * CSRF stays off: the playground routes are hit by the Japa API client and by
   * curl during manual QA, neither of which carries a CSRF token.
   */
  csrf: {
    enabled: false,
    exceptRoutes: [],
    enableXsrfCookie: true,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  },

  xFrame: {
    enabled: true,
    action: 'DENY',
  },

  hsts: {
    enabled: true,
    maxAge: '180 days',
  },

  contentTypeSniffing: {
    enabled: true,
  },
})

export default shieldConfig
