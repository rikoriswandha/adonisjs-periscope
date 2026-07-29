import { setTimeout as sleep } from 'node:timers/promises'
import { tracingChannel } from 'node:diagnostics_channel'

import type { HttpContext } from '@adonisjs/core/http'
import { healthChecks } from '#start/health'

import { demoQueue } from '../periscope/demo_queue_adapter.js'

/**
 * The channel @adonisjs/redis publishes command traces on. The playground has no Redis server, so
 * the fixture traces fake commands through the same channel the RedisWatcher subscribes to — the
 * watcher observes the channel, not a connection, which is exactly what this proves.
 */
const redisChannel = tracingChannel<'adonisjs.redis.command', object>('adonisjs.redis.command')

export default class ShowcaseController {
  /**
   * Exercise the opt-in watchers (redis, job, schedule) that no installed playground integration
   * emits for: fake Redis command traces plus a full job lifecycle through the demo queue adapter.
   * Session entries come for free — this request initiates and commits a session.
   */
  async handle({ session }: HttpContext) {
    session.put('showcase:visits', Number(session.get('showcase:visits', 0)) + 1)

    /**
     * One successful command, one failing one — the watcher tags the latter `failed`.
     */
    await redisChannel.tracePromise(async () => sleep(2), {
      command: { name: 'get', args: ['showcase:counter'] },
    })
    await redisChannel
      .tracePromise(
        async () => {
          await sleep(1)
          throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
        },
        { command: { name: 'incr', args: ['showcase:not-a-counter'] } }
      )
      .catch(() => {})

    const observer = demoQueue.observer
    if (observer !== undefined) {
      const completed = {
        adapter: 'playground-demo',
        queue: 'emails',
        jobId: `showcase-${Date.now()}`,
        name: 'send-welcome-email',
        payload: { to: 'showcase@periscope.test', password: 'showcase-job-secret' },
        attempts: 1,
      }
      observer.started(completed)
      await sleep(5)
      observer.completed({ ...completed, result: { delivered: true } })

      const failed = {
        adapter: 'playground-demo',
        queue: 'reports',
        jobId: `showcase-${Date.now()}-fail`,
        name: 'generate-report',
        payload: { reportId: 42 },
        attempts: 3,
      }
      observer.started(failed)
      await sleep(2)
      observer.failed({ ...failed, error: new Error('report template missing') })

      observer.scheduled({
        adapter: 'playground-demo',
        queue: 'maintenance',
        jobId: `showcase-${Date.now()}-cron`,
        name: 'prune-old-entries',
        scheduledAt: new Date(Date.now() + 60_000),
      })
    }

    const health = await healthChecks.run()

    return {
      session: { visits: session.get('showcase:visits') },
      redis: { traced: 2 },
      jobs: { emitted: observer !== undefined },
      health: { status: health.status, checks: health.checks.length },
    }
  }
}
