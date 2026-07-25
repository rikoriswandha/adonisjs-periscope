import { defineConfig } from '@adonisjs/mail'
import { JSONTransport } from '@adonisjs/mail/transports/json'

/**
 * The playground never sends real mail. The JSON transport hands the composed
 * message straight back as a JSON object, so `/fanout` can exercise the whole
 * mail pipeline (and the `mail:sending` / `mail:sent` events Periscope's future
 * MailWatcher listens to) without touching the network.
 *
 * `transports.json()` does not exist — the exported `transports` helper only
 * covers the network transports. The JSON transport is wired by passing its
 * factory directly, which is exactly what `MailManagerTransportFactory` expects.
 */
const mailConfig = defineConfig({
  default: 'json',

  from: {
    address: 'playground@periscope.test',
    name: 'Periscope Playground',
  },

  mailers: {
    json: () => new JSONTransport(),
  },
})

export default mailConfig

/**
 * Inferring types for the list of mailers you have configured
 * in your application.
 */
declare module '@adonisjs/mail/types' {
  export interface MailersList extends InferMailers<typeof mailConfig> {}
}
