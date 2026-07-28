import { Bouncer } from '@adonisjs/bouncer'
import cache from '@adonisjs/cache/services/main'
import type { HttpContext } from '@adonisjs/core/http'
import mail from '@adonisjs/mail/services/main'
import { dump } from 'adonisjs-periscope/dump'

import { inspectWave2Ability } from '#abilities/main'
import FanoutNotification from '#mails/fanout_notification'
import User from '#models/user'

const CACHE_KEY = 'wave2:fixture'
const USER_EMAIL = 'wave2@periscope.test'

export default class Wave2Controller {
  /**
   * Exercise every Phase 6 watcher from one request-scoped batch. The fixture uses the installed
   * integrations rather than emitting their framework events by hand, and removes all mutable
   * database and cache state before returning.
   */
  async handle({ request }: HttpContext) {
    await cache.clear()
    const missed = await cache.get({ key: CACHE_KEY })
    await cache.set({
      key: CACHE_KEY,
      value: { phase: 6, password: 'wave2-cache-secret' },
    })
    const cached = await cache.get<{ phase: number; password: string }>({ key: CACHE_KEY })

    await User.query().where('email', USER_EMAIL).delete()
    const user = await User.create({
      fullName: 'Wave 2 Fixture',
      email: USER_EMAIL,
      password: 'wave2-model-secret',
    })

    try {
      user.fullName = 'Wave 2 Updated'
      await user.save()

      const allowed = await new Bouncer(user).allows(inspectWave2Ability, {
        ownerId: user.id,
        password: 'wave2-gate-secret',
      })

      const dumped = dump({ phase: 6, password: 'wave2-dump-secret' })
      const sent = await mail.send(new FanoutNotification('wave2@periscope.test'))

      const probeUrl = new URL('/?token=wave2-http-secret&phase=6', request.completeUrl())
      const probe = await fetch(probeUrl, {
        headers: { 'authorization': 'Bearer wave2-http-secret', 'x-wave2-probe': 'true' },
      })
      await probe.json()

      return {
        cache: { missed: missed === undefined, phase: cached.phase },
        model: { id: user.id, fullName: user.fullName },
        gate: { allowed },
        dump: { phase: dumped.phase },
        mail: { messageId: sent.messageId },
        httpClient: { status: probe.status },
      }
    } finally {
      await cache.delete({ key: CACHE_KEY })
      await user.delete()
    }
  }
}
