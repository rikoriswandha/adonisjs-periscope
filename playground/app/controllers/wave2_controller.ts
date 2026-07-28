import { Bouncer } from '@adonisjs/bouncer'
import cache from '@adonisjs/cache/services/main'
import type { HttpContext } from '@adonisjs/core/http'
import mail from '@adonisjs/mail/services/main'
import { dump } from '@rikology/adonisjs-periscope/dump'

import { inspectWave2Ability } from '#abilities/main'
import FanoutNotification from '#mails/fanout_notification'
import User from '#models/user'

const CACHE_KEY = 'integration:fixture'
const USER_EMAIL = 'integration@periscope.test'

export default class Wave2Controller {
  /**
   * Exercise every integration-backed watcher from one request-scoped batch. The fixture uses the installed
   * integrations rather than emitting their framework events by hand, and removes all mutable
   * database and cache state before returning.
   */
  async handle({ request }: HttpContext) {
    await cache.clear()
    const missed = await cache.get({ key: CACHE_KEY })
    await cache.set({
      key: CACHE_KEY,
      value: { scenario: 'integration', password: 'cache-secret' },
    })
    const cached = await cache.get<{ scenario: string; password: string }>({ key: CACHE_KEY })

    await User.query().where('email', USER_EMAIL).delete()
    const user = await User.create({
      fullName: 'Integration Fixture',
      email: USER_EMAIL,
      password: 'model-secret',
    })

    try {
      user.fullName = 'Integration Updated'
      await user.save()

      const allowed = await new Bouncer(user).allows(inspectWave2Ability, {
        ownerId: user.id,
        password: 'gate-secret',
      })

      const dumped = dump({ scenario: 'integration', password: 'dump-secret' })
      const sent = await mail.send(new FanoutNotification('integration@periscope.test'))

      const probeUrl = new URL(
        '/?token=http-client-secret&scenario=integration',
        request.completeUrl()
      )
      const probe = await fetch(probeUrl, {
        headers: { 'authorization': 'Bearer http-client-secret', 'x-periscope-probe': 'true' },
      })
      await probe.json()

      return {
        cache: { missed: missed === undefined, scenario: cached.scenario },
        model: { id: user.id, fullName: user.fullName },
        gate: { allowed },
        dump: { scenario: dumped.scenario },
        mail: { messageId: sent.messageId },
        httpClient: { status: probe.status },
      }
    } finally {
      await cache.delete({ key: CACHE_KEY })
      await user.delete()
    }
  }
}
