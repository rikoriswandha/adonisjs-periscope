import mail from '@adonisjs/mail/services/main'
import type { HttpContext } from '@adonisjs/core/http'

import FanoutRequested from '#events/fanout_requested'
import FanoutNotification from '#mails/fanout_notification'

export default class FanoutController {
  /**
   * `GET /fanout` — one request that fans out into three different watcher
   * surfaces: a custom application event, a warn-level log and an outgoing
   * mail (through the non-sending JSON transport).
   */
  async handle({ logger }: HttpContext) {
    await FanoutRequested.dispatch('playground', 3)

    logger.warn({ route: '/fanout' }, 'fanout route reached')

    const sent = await mail.send(new FanoutNotification('inbox@periscope.test'))

    return {
      event: FanoutRequested.name,
      logged: 'warn',
      messageId: sent.messageId,
    }
  }
}
