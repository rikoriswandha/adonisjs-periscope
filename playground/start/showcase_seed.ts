/*
|--------------------------------------------------------------------------
| Showcase seed
|--------------------------------------------------------------------------
|
| The redis, job, schedule and dump watchers have no ambient source in the playground: nothing
| traces Redis commands, no queue runs, and `dump()` records only while the dashboard holds a
| `dump-open` lease. Without this preload their dashboard counters sit at zero until someone
| knows to hit `/showcase` with the Dumps page open.
|
| So the dev server seeds them itself: once on boot and then every minute, it traces two fake
| Redis commands, drives a job lifecycle plus a schedule through the demo queue adapter, and
| takes a short-lived dump lease so one `dump()` call lands. Tests never see this — the seed
| only runs on the dev server.
|
*/

import { setTimeout as sleep } from 'node:timers/promises'
import { tracingChannel } from 'node:diagnostics_channel'

import app from '@adonisjs/core/services/app'
import recorder from '@rikology/adonisjs-periscope/services/recorder'
import { dump } from '@rikology/adonisjs-periscope/dump'
import { BatchScope, Flag } from '@rikology/adonisjs-periscope'

import { demoQueue } from '../app/periscope/demo_queue_adapter.js'

/**
 * The channel @adonisjs/redis publishes command traces on; the RedisWatcher observes the channel,
 * not a connection, so fake traces exercise the real pipeline.
 */
const redisChannel = tracingChannel<'adonisjs.redis.command', object>('adonisjs.redis.command')

/**
 * The DumpWatcher polls the `dump-open` flag on this cadence; the seed must outwait one poll
 * before its `dump()` call can land.
 */
const DUMP_FLAG_POLL_MS = 1_000

const RESEED_INTERVAL_MS = 60_000

async function seedOnce() {
  const context = BatchScope.createContext('command')

  await BatchScope.runWith(context, async () => {
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
        jobId: `seed-${Date.now()}`,
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
        jobId: `seed-${Date.now()}-fail`,
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
        jobId: `seed-${Date.now()}-cron`,
        name: 'prune-old-entries',
        scheduledAt: new Date(Date.now() + RESEED_INTERVAL_MS),
      })
    }

    /**
     * Lease the dump flag exactly like a dashboard tab would, outwait one watcher poll so the
     * synchronous `dump()` gate observes it, and let the lease expire on its own.
     */
    await recorder.store.setFlag(`${Flag.DUMP_OPEN}:playground-seed`, 'playground-seed', {
      expiresAt: new Date(Date.now() + DUMP_FLAG_POLL_MS * 3),
    })
    await sleep(DUMP_FLAG_POLL_MS + 200)
    dump({ seeded: true, at: new Date().toISOString(), password: 'showcase-dump-secret' })
  })

  await recorder.flush(context)
}

app.ready(async () => {
  if (!app.inDev) {
    return
  }

  await seedOnce()

  const timer = setInterval(() => {
    void seedOnce().catch(() => {})
  }, RESEED_INTERVAL_MS)
  timer.unref()
})
