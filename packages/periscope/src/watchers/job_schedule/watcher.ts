import { IncomingEntry } from '../../entry.ts'
import { BatchScope } from '../../recorder/context.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard, safeguardAsync } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type {
  BatchContext,
  QueueJobEvent,
  QueueJobResult,
  QueueWatcherObserver,
  Watcher,
} from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { JobEntryContent, ScheduleEntryContent } from './types.ts'

type ActiveJob = {
  context: BatchContext
  event: QueueJobEvent
  startedAt: bigint
}

const MAX_ACTIVE_JOBS = 1_000

function jobKey(event: QueueJobEvent): string {
  return `${event.adapter}\u0000${event.queue}\u0000${event.jobId}`
}

function durationMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000
}

/** Correlates pluggable queue lifecycle adapters without coupling Periscope to one queue package. */
export class JobScheduleWatcher implements Watcher, QueueWatcherObserver {
  readonly name = WatcherName.JOB_SCHEDULE
  readonly stats = { jobs: 0, schedules: 0 }

  readonly #context: WatcherContext
  readonly #activeJobs = new Map<string, ActiveJob>()
  readonly #cleanups: (() => void | Promise<void>)[] = []
  readonly #flushes = new Set<Promise<unknown>>()
  #active = false

  constructor(context: WatcherContext) {
    this.#context = context
  }

  async register(): Promise<void> {
    if (this.#active) return
    this.#active = true

    for (const adapter of this.#context.config.watchers.job_schedule.adapters) {
      const cleanup = await adapter.register(this, {
        capturePayload: this.#context.config.watchers.job_schedule.capturePayload,
      })
      if (typeof cleanup === 'function') this.#cleanups.push(cleanup)
    }
  }

  async cleanup(): Promise<void> {
    this.#active = false
    const cleanups = this.#cleanups.splice(0)
    this.#activeJobs.clear()
    await Promise.allSettled(
      cleanups.map((cleanup) =>
        safeguardAsync('periscope.watcher.job_schedule.cleanup', () => Promise.resolve(cleanup()))
      )
    )
    await Promise.all(this.#flushes)
  }

  #flush(context: BatchContext): void {
    const flushing = safeguardAsync('periscope.watcher.job_schedule.flush', () =>
      this.#context.recorder.flush(context, 'final')
    )
    this.#flushes.add(flushing)
    void flushing.then(() => this.#flushes.delete(flushing))
  }

  started(event: QueueJobEvent): void {
    safeguard('periscope.watcher.job_schedule.started', () => {
      if (!this.#active) return
      const key = jobKey(event)
      this.#activeJobs.delete(key)
      this.#activeJobs.set(key, {
        context: BatchScope.createContext('queue'),
        event,
        startedAt: process.hrtime.bigint(),
      })

      if (this.#activeJobs.size > MAX_ACTIVE_JOBS) {
        const oldest = this.#activeJobs.keys().next().value

        if (oldest !== undefined) this.#activeJobs.delete(oldest)
      }
    })
  }

  completed(event: QueueJobResult): void {
    this.#finish('completed', event)
  }

  failed(event: QueueJobResult): void {
    this.#finish('failed', event)
  }

  scheduled(event: QueueJobEvent): void {
    safeguard('periscope.watcher.job_schedule.scheduled', () => {
      if (!this.#active) return
      const context = BatchScope.createContext('queue')
      const scheduledAt = event.scheduledAt
      const content: ScheduleEntryContent = {
        adapter: event.adapter,
        queue: event.queue,
        jobId: event.jobId,
        ...(event.name === undefined ? {} : { name: event.name }),
        ...(scheduledAt === undefined
          ? {}
          : {
              scheduledAt: scheduledAt.toISOString(),
              delayMs: Math.max(0, scheduledAt.getTime() - Date.now()),
            }),
        ...(this.#context.config.watchers.job_schedule.capturePayload && event.payload !== undefined
          ? { payload: safeSerialize(event.payload) }
          : {}),
      }

      BatchScope.runWith(context, () => {
        this.#context.recorder.record(
          IncomingEntry.make(EntryType.SCHEDULE, content).withTags(
            `queue:${event.queue}`,
            `adapter:${event.adapter}`
          )
        )
      })
      this.stats.schedules += 1
      this.#flush(context)
    })
  }

  #finish(status: JobEntryContent['status'], event: QueueJobResult): void {
    safeguard('periscope.watcher.job_schedule.finished', () => {
      if (!this.#active) return
      const key = jobKey(event)
      const active = this.#activeJobs.get(key)
      this.#activeJobs.delete(key)
      const context = active?.context ?? BatchScope.createContext('queue')
      const source = active?.event ?? event
      const capturePayload = this.#context.config.watchers.job_schedule.capturePayload
      const name = source.name ?? event.name
      const payload = source.payload === undefined ? event.payload : source.payload
      const content: JobEntryContent = {
        adapter: event.adapter,
        queue: event.queue,
        jobId: event.jobId,
        status,
        ...(name === undefined ? {} : { name }),
        ...(event.durationMs === undefined
          ? active === undefined
            ? {}
            : { durationMs: durationMs(active.startedAt) }
          : { durationMs: event.durationMs }),
        ...(event.attempts === undefined ? {} : { attempts: event.attempts }),
        ...(capturePayload && payload !== undefined ? { payload: safeSerialize(payload) } : {}),
        ...(capturePayload && event.result !== undefined
          ? { result: safeSerialize(event.result) }
          : {}),
        ...(event.error === undefined ? {} : { error: safeSerialize(event.error) }),
      }

      BatchScope.runWith(context, () => {
        this.#context.recorder.record(
          IncomingEntry.make(EntryType.JOB, content).withTags(
            `queue:${event.queue}`,
            `adapter:${event.adapter}`,
            `status:${status}`
          )
        )
      })
      this.stats.jobs += 1
      this.#flush(context)
    })
  }
}
