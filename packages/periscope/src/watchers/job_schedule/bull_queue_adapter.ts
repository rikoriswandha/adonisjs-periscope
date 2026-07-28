import { QueueEvents } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

import type { QueueWatcherAdapter, QueueWatcherObserver } from '../../types.ts'

export type BullQueueTarget = {
  name: string
  connection: ConnectionOptions
  prefix?: string
}

const DEFAULT_READY_TIMEOUT_MS = 10_000

export type BullQueueAdapterOptions = {
  queues: BullQueueTarget[]
  readyTimeoutMs?: number
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
  readonly #readyTimeoutMs: number

  constructor(options: BullQueueAdapterOptions) {
    this.#targets = options.queues.map((queue) => ({ ...queue }))
    this.#readyTimeoutMs =
      options.readyTimeoutMs !== undefined &&
      Number.isFinite(options.readyTimeoutMs) &&
      options.readyTimeoutMs > 0
        ? Math.floor(options.readyTimeoutMs)
        : DEFAULT_READY_TIMEOUT_MS
  }

  async #waitUntilReady(events: QueueEvents, queue: string): Promise<void> {
    const readinessTimeout = Promise.withResolvers<never>()
    const timeout = setTimeout(() => {
      readinessTimeout.reject(
        new Error(`Timed out waiting ${this.#readyTimeoutMs}ms for BullMQ queue "${queue}" events`)
      )
    }, this.#readyTimeoutMs)
    timeout.unref()

    try {
      await Promise.race([events.waitUntilReady(), readinessTimeout.promise])
    } finally {
      clearTimeout(timeout)
    }
  }

  async #closeEvents(): Promise<void> {
    const events = this.#events.splice(0)
    const results = await Promise.allSettled(events.map((queueEvents) => queueEvents.close()))
    const errors: unknown[] = []

    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(result.reason)
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to close ${errors.length} BullMQ QueueEvents instance${errors.length === 1 ? '' : 's'}`
      )
    }
  }

  async register(observer: QueueWatcherObserver): Promise<() => Promise<void>> {
    try {
      for (const target of this.#targets) {
        const events = new QueueEvents(target.name, {
          connection: target.connection,
          ...(target.prefix === undefined ? {} : { prefix: target.prefix }),
        })
        this.#events.push(events)
        events.on('error', () => undefined)

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

        await this.#waitUntilReady(events, target.name)
      }
    } catch (error) {
      try {
        await this.#closeEvents()
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'BullMQ queue event registration failed and cleanup was incomplete'
        )
      }

      throw error
    }

    return () => this.#closeEvents()
  }
}
