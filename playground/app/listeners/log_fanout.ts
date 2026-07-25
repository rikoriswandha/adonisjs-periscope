import logger from '@adonisjs/core/services/logger'

import type FanoutRequested from '#events/fanout_requested'

export default class LogFanout {
  handle(event: FanoutRequested) {
    logger.info({ source: event.source, itemsCount: event.itemsCount }, 'fanout event handled')
  }
}
