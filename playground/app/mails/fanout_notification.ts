import { BaseMail } from '@adonisjs/mail'

/**
 * Sent by `GET /fanout` through the JSON transport configured in
 * `config/mail.ts`. Plain text on purpose — the playground has no view layer.
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
  }
}
