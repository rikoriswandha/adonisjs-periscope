import { Queue, QueueEvents } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

import type {
  QueueJobEvent,
  QueueWatcherAdapter,
  QueueWatcherObserver,
  QueueWatcherRegistrationOptions,
} from '../../types.ts'

export type BullQueueTarget = {
  name: string
  connection: ConnectionOptions
  prefix?: string
}

type BullQueueResources = {
  events: QueueEvents
  queue: Queue
}

type BullJobMetadata = Pick<QueueJobEvent, 'name' | 'payload' | 'attempts'>

const DEFAULT_READY_TIMEOUT_MS = 10_000
const DEFAULT_JOB_LOOKUP_TIMEOUT_MS = 1_000
const MAX_TRACKED_JOBS = 1_000

export type BullQueueAdapterOptions = {
  queues: BullQueueTarget[]
  readyTimeoutMs?: number
  jobLookupTimeoutMs?: number
}

/**
 * Non-invasive BullMQ lifecycle adapter. It works alongside @rlanz/bull-queue because that
 * package uses BullMQ queues, while QueueEvents observes the same Redis event stream without
 * replacing or reaching into its workers.
 */
export class BullQueueAdapter implements QueueWatcherAdapter {
  readonly name = 'bullmq'
  readonly #targets: BullQueueTarget[]
  readonly #resources: BullQueueResources[] = []
  readonly #jobTasks = new Map<string, Promise<void>>()
  readonly #jobMetadata = new Map<string, BullJobMetadata>()
  readonly #startedAt = new Map<string, bigint>()
  readonly #readyTimeoutMs: number
  readonly #jobLookupTimeoutMs: number
  #active = false

  constructor(options: BullQueueAdapterOptions) {
    this.#targets = options.queues.map((queue) => ({ ...queue }))
    this.#readyTimeoutMs =
      options.readyTimeoutMs !== undefined &&
      Number.isFinite(options.readyTimeoutMs) &&
      options.readyTimeoutMs > 0
        ? Math.floor(options.readyTimeoutMs)
        : DEFAULT_READY_TIMEOUT_MS
    this.#jobLookupTimeoutMs =
      options.jobLookupTimeoutMs !== undefined &&
      Number.isFinite(options.jobLookupTimeoutMs) &&
      options.jobLookupTimeoutMs > 0
        ? Math.floor(options.jobLookupTimeoutMs)
        : DEFAULT_JOB_LOOKUP_TIMEOUT_MS
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

  async #jobDetails(
    queue: Queue,
    jobId: string,
    capturePayload: boolean
  ): Promise<BullJobMetadata | undefined> {
    const lookupTimeout = Promise.withResolvers<undefined>()
    const timeout = setTimeout(() => lookupTimeout.resolve(undefined), this.#jobLookupTimeoutMs)
    timeout.unref()

    try {
      const job = await Promise.race([
        queue.getJob(jobId).catch(() => undefined),
        lookupTimeout.promise,
      ])
      if (job === undefined) return undefined

      const attemptsMade = Number(job.attemptsMade)
      return {
        ...(typeof job.name === 'string' ? { name: job.name } : {}),
        ...(Number.isFinite(attemptsMade)
          ? { attempts: Math.max(0, Math.floor(attemptsMade)) }
          : {}),
        ...(capturePayload && job.data !== undefined ? { payload: job.data } : {}),
      }
    } catch {
      return undefined
    } finally {
      clearTimeout(timeout)
    }
  }

  #rememberMetadata(key: string, metadata: BullJobMetadata): void {
    if (!this.#jobMetadata.has(key) && this.#jobMetadata.size >= MAX_TRACKED_JOBS) {
      const oldest = this.#jobMetadata.keys().next().value
      if (oldest !== undefined) this.#jobMetadata.delete(oldest)
    }
    this.#jobMetadata.set(key, metadata)
  }

  #observeWithMetadata(
    key: string,
    queue: Queue,
    jobId: string,
    capturePayload: boolean,
    phase: 'started' | 'terminal' | 'scheduled',
    emit: (metadata: BullJobMetadata | undefined) => void
  ): void {
    if (!this.#active) return

    const previous = this.#jobTasks.get(key)
    if (previous === undefined && this.#jobTasks.size >= MAX_TRACKED_JOBS) {
      const cached = this.#jobMetadata.get(key)
      if (phase === 'terminal') this.#jobMetadata.delete(key)
      try {
        emit(cached)
      } catch {
        // QueueEvents listeners must never reject into BullMQ.
      }
      return
    }

    const task = (previous ?? Promise.resolve())
      .then(async () => {
        if (!this.#active) return

        const cached = this.#jobMetadata.get(key)
        const fresh = await this.#jobDetails(queue, jobId, capturePayload)
        if (!this.#active) return

        let metadata =
          fresh === undefined
            ? cached
            : {
                ...cached,
                ...fresh,
              }

        if (phase === 'started' && metadata !== undefined) {
          this.#rememberMetadata(key, metadata)
        } else if (phase === 'terminal') {
          this.#jobMetadata.delete(key)
          if (fresh?.attempts === undefined && cached?.attempts !== undefined) {
            metadata = { ...metadata, attempts: cached.attempts + 1 }
          }
        }

        try {
          emit(metadata)
        } catch {
          // EventEmitter listeners must never reject into BullMQ.
        }
      })
      .catch(() => undefined)

    this.#jobTasks.set(key, task)
    void task.finally(() => {
      if (this.#jobTasks.get(key) === task) this.#jobTasks.delete(key)
    })
  }

  async #closeResources(): Promise<void> {
    this.#active = false
    await Promise.allSettled(this.#jobTasks.values())
    this.#jobTasks.clear()
    this.#jobMetadata.clear()
    this.#startedAt.clear()

    const resources = this.#resources.splice(0)
    const results = await Promise.allSettled(
      resources.flatMap(({ events, queue }) => [
        Promise.resolve().then(() => events.close()),
        Promise.resolve().then(() => queue.close()),
      ])
    )
    const errors: unknown[] = []

    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason)
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to close ${errors.length} BullMQ resource${errors.length === 1 ? '' : 's'}`
      )
    }
  }

  async register(
    observer: QueueWatcherObserver,
    options: QueueWatcherRegistrationOptions = { capturePayload: false }
  ): Promise<() => Promise<void>> {
    this.#active = true

    try {
      for (const [targetIndex, target] of this.#targets.entries()) {
        const queueOptions = {
          connection: target.connection,
          ...(target.prefix === undefined ? {} : { prefix: target.prefix }),
        }
        const queue = new Queue(target.name, queueOptions)
        const events = new QueueEvents(target.name, queueOptions)
        this.#resources.push({ events, queue })
        queue.on('error', () => undefined)
        events.on('error', () => undefined)

        events.on('active', ({ jobId }) => {
          if (!this.#active) return
          const key = `${targetIndex}\u0000${jobId}`
          if (!this.#startedAt.has(key) && this.#startedAt.size >= MAX_TRACKED_JOBS) {
            const oldest = this.#startedAt.keys().next().value
            if (oldest !== undefined) this.#startedAt.delete(oldest)
          }
          this.#startedAt.set(key, process.hrtime.bigint())

          this.#observeWithMetadata(
            key,
            queue,
            jobId,
            options.capturePayload,
            'started',
            (metadata) => {
              observer.started({
                adapter: this.name,
                queue: target.name,
                jobId,
                ...(metadata ?? {}),
              })
            }
          )
        })
        events.on('completed', ({ jobId, returnvalue }) => {
          if (!this.#active) return
          const key = `${targetIndex}\u0000${jobId}`
          const startedAt = this.#startedAt.get(key)
          this.#startedAt.delete(key)
          const durationMs =
            startedAt === undefined
              ? undefined
              : Number(process.hrtime.bigint() - startedAt) / 1_000_000

          this.#observeWithMetadata(
            key,
            queue,
            jobId,
            options.capturePayload,
            'terminal',
            (metadata) => {
              observer.completed({
                adapter: this.name,
                queue: target.name,
                jobId,
                ...(metadata ?? {}),
                ...(durationMs === undefined ? {} : { durationMs }),
                ...(options.capturePayload && returnvalue !== undefined
                  ? { result: returnvalue }
                  : {}),
              })
            }
          )
        })
        events.on('failed', ({ jobId, failedReason }) => {
          if (!this.#active) return
          const key = `${targetIndex}\u0000${jobId}`
          const startedAt = this.#startedAt.get(key)
          this.#startedAt.delete(key)
          const durationMs =
            startedAt === undefined
              ? undefined
              : Number(process.hrtime.bigint() - startedAt) / 1_000_000

          this.#observeWithMetadata(
            key,
            queue,
            jobId,
            options.capturePayload,
            'terminal',
            (metadata) => {
              observer.failed({
                adapter: this.name,
                queue: target.name,
                jobId,
                ...(metadata ?? {}),
                ...(durationMs === undefined ? {} : { durationMs }),
                error: { message: failedReason },
              })
            }
          )
        })
        events.on('delayed', ({ jobId, delay }) => {
          if (!this.#active) return
          const rawDelay = Number(delay)
          const scheduledFor = Number.isFinite(rawDelay)
            ? new Date(rawDelay > Date.now() ? rawDelay : Date.now() + Math.max(0, rawDelay))
            : undefined

          this.#observeWithMetadata(
            `${targetIndex}\u0000${jobId}`,
            queue,
            jobId,
            options.capturePayload,
            'scheduled',
            (metadata) => {
              observer.scheduled({
                adapter: this.name,
                queue: target.name,
                jobId,
                ...(metadata ?? {}),
                ...(scheduledFor === undefined ? {} : { scheduledAt: scheduledFor }),
              })
            }
          )
        })

        await this.#waitUntilReady(events, target.name)
      }
    } catch (error) {
      try {
        await this.#closeResources()
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'BullMQ queue event registration failed and cleanup was incomplete'
        )
      }

      throw error
    }

    return () => this.#closeResources()
  }
}
