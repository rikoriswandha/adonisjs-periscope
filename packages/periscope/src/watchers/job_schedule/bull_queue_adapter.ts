import { QueueEvents } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

import type { QueueWatcherAdapter, QueueWatcherObserver } from '../../types.ts'

export type BullQueueTarget = {
  name: string
  connection: ConnectionOptions
  prefix?: string
}

export type BullQueueAdapterOptions = {
  queues: BullQueueTarget[]
}

/**
 * Non-invasive BullMQ lifecycle adapter. It works alongside @rlanz/bull-queue because that
 * package uses BullMQ queues, while QueueEvents observes the same Redis event stream without
 * replacing or reaching into its workers.
 */
export class BullQueueAdapter implements QueueWatcherAdapter {
  readonly name = 'bullmq'
  readonly #targets: BullQueueTarget[]
  readonly #events: QueueEvents[] = []

  constructor(options: BullQueueAdapterOptions) {
    this.#targets = options.queues.map((queue) => ({ ...queue }))
  }

  async register(observer: QueueWatcherObserver): Promise<() => Promise<void>> {
    for (const target of this.#targets) {
      const events = new QueueEvents(target.name, {
        connection: target.connection,
        ...(target.prefix === undefined ? {} : { prefix: target.prefix }),
      })
      this.#events.push(events)

      events.on('active', ({ jobId }) => {
        observer.started({ adapter: this.name, queue: target.name, jobId })
      })
      events.on('completed', ({ jobId, returnvalue }) => {
        observer.completed({
          adapter: this.name,
          queue: target.name,
          jobId,
          result: returnvalue,
        })
      })
      events.on('failed', ({ jobId, failedReason }) => {
        observer.failed({
          adapter: this.name,
          queue: target.name,
          jobId,
          error: { message: failedReason },
        })
      })
      events.on('delayed', ({ jobId, delay }) => {
        const rawDelay = Number(delay)
        const scheduledAt = Number.isFinite(rawDelay)
          ? new Date(rawDelay > Date.now() ? rawDelay : Date.now() + Math.max(0, rawDelay))
          : undefined
        observer.scheduled({
          adapter: this.name,
          queue: target.name,
          jobId,
          ...(scheduledAt === undefined ? {} : { scheduledAt }),
        })
      })

      await events.waitUntilReady()
    }

    return async () => {
      const events = this.#events.splice(0)
      await Promise.allSettled(events.map((queueEvents) => queueEvents.close()))
    }
  }
}
