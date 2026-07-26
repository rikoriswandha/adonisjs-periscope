import { BaseMail } from '@adonisjs/mail'

/**
 * Sent through the JSON transport with literal text and HTML bodies, so the playground can
 * exercise both dashboard preview paths without needing a template engine.
 */
export default class FanoutNotification extends BaseMail {
  subject = 'Periscope playground fanout'

  constructor(private recipient: string) {
    super()
  }

  prepare() {
    this.message
      .to(this.recipient)
      .text('The /fanout route dispatched an event, logged a warning and sent this mail.')
      .html(
        '<main><h1>Periscope playground</h1><p>The /fanout route exercised the mail watcher.</p></main>'
      )
  }
}
