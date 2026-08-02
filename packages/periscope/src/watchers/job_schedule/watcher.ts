import { randomUUID } from 'node:crypto'

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
  ScheduledTaskEvent,
  ScheduledTaskResult,
  SchedulerWatcherObserver,
  Watcher,
} from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { JobEntryContent, ScheduledTaskEntryContent, ScheduleEntryContent } from './types.ts'

type ActiveJob = {
  context: BatchContext
  event: QueueJobEvent
  startedAt: bigint
}

type ActiveTask = {
  context: BatchContext
  event: ScheduledTaskEvent
  startedAt: bigint
}

const MAX_ACTIVE = 1_000

function jobKey(event: QueueJobEvent): string {
  return `${event.adapter}\u0000${event.queue}\u0000${event.jobId}`
}

function taskKey(event: ScheduledTaskEvent): string {
  return `${event.adapter}\u0000${event.task}\u0000${event.runId ?? ''}`
}

function durationMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000
}

/**
 * Rebuild a queue scope from metadata carried across a process boundary.
 *
 * Contexts themselves cannot cross the queue transport, so only their stable id is restored;
 * sampling and trace state remain local to the worker that is doing the recording.
 */
function correlatedContext(correlationId: string): BatchContext {
  return { ...BatchScope.createContext('queue'), batchId: correlationId }
}

/** Correlates pluggable queue lifecycle adapters without coupling Periscope to one queue package. */
export class JobScheduleWatcher implements Watcher, QueueWatcherObserver, SchedulerWatcherObserver {
  readonly name = WatcherName.JOB_SCHEDULE
  readonly stats = { jobs: 0, schedules: 0, tasks: 0 }

  readonly #context: WatcherContext
  readonly #activeJobs = new Map<string, ActiveJob>()
  readonly #activeTasks = new Map<string, ActiveTask>()
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

    for (const adapter of this.#context.config.watchers.job_schedule.schedulers) {
      const cleanup = await safeguardAsync(
        'periscope.watcher.job_schedule.register_scheduler',
        () =>
          adapter.register(this, {
            capturePayload: this.#context.config.watchers.job_schedule.capturePayload,
          })
      )
      if (typeof cleanup === 'function') this.#cleanups.push(cleanup)
    }
  }

  async cleanup(): Promise<void> {
    this.#active = false
    const cleanups = this.#cleanups.splice(0)
    this.#activeJobs.clear()
    this.#activeTasks.clear()
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

  dispatching(event: QueueJobEvent): { correlationId: string } {
    const correlationId = randomUUID()

    safeguard('periscope.watcher.job_schedule.dispatching', () => {
      if (!this.#active) return
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

      /**
       * Deliberately do not open or flush a queue context here. Dispatch runs inside the producer's
       * request/command/ambient scope, and the correlation tag is the bridge from that parent batch
       * to the independently persisted worker batch.
       */
      this.#context.recorder.record(
        IncomingEntry.make(EntryType.SCHEDULE, content).withTags(
          `queue:${event.queue}`,
          `adapter:${event.adapter}`,
          `queue-correlation:${correlationId}`
        )
      )
      this.stats.schedules += 1
    })

    return { correlationId }
  }

  async wrapJob<T>(event: QueueJobEvent, run: () => Promise<T>): Promise<T> {
    if (!this.#active || event.correlationId === undefined) return run()

    const context = correlatedContext(event.correlationId)
    try {
      return await BatchScope.runWith(context, run)
    } finally {
      await this.#context.recorder.flush(context, 'final')
    }
  }

  started(event: QueueJobEvent): void {
    safeguard('periscope.watcher.job_schedule.started', () => {
      if (!this.#active) return
      const key = jobKey(event)
      this.#activeJobs.delete(key)
      this.#activeJobs.set(key, {
        context:
          event.correlationId === undefined
            ? BatchScope.createContext('queue')
            : correlatedContext(event.correlationId),
        event,
        startedAt: process.hrtime.bigint(),
      })

      if (this.#activeJobs.size > MAX_ACTIVE) {
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

  taskStarted(event: ScheduledTaskEvent): void {
    safeguard('periscope.watcher.job_schedule.task_started', () => {
      if (!this.#active) return
      const key = taskKey(event)
      this.#activeTasks.delete(key)
      this.#activeTasks.set(key, {
        context: BatchScope.createContext('schedule'),
        event,
        startedAt: process.hrtime.bigint(),
      })

      if (this.#activeTasks.size > MAX_ACTIVE) {
        const oldest = this.#activeTasks.keys().next().value

        if (oldest !== undefined) this.#activeTasks.delete(oldest)
      }
    })
  }

  async wrapTask<T>(event: ScheduledTaskEvent, run: () => Promise<T>): Promise<T> {
    const context = safeguard(
      'periscope.watcher.job_schedule.wrap_task',
      () => {
        if (!this.#active) return
        return this.#activeTasks.get(taskKey(event))?.context
      },
      undefined
    )

    return context === undefined ? run() : BatchScope.runWith(context, run)
  }

  taskCompleted(event: ScheduledTaskResult): void {
    safeguard('periscope.watcher.job_schedule.task_completed', () => {
      this.#finishTask('completed', event)
    })
  }

  taskFailed(event: ScheduledTaskResult): void {
    safeguard('periscope.watcher.job_schedule.task_failed', () => {
      this.#finishTask('failed', event)
    })
  }

  #finishTask(status: ScheduledTaskEntryContent['status'], event: ScheduledTaskResult): void {
    if (!this.#active) return
    const key = taskKey(event)
    const active = this.#activeTasks.get(key)
    this.#activeTasks.delete(key)
    const context = active?.context ?? BatchScope.createContext('schedule')
    const source = active?.event ?? event
    const schedule = source.schedule ?? event.schedule
    const runId = source.runId ?? event.runId
    const content: ScheduledTaskEntryContent = {
      adapter: event.adapter,
      task: event.task,
      status,
      ...(schedule === undefined ? {} : { schedule }),
      ...(runId === undefined ? {} : { runId }),
      ...(event.durationMs === undefined
        ? active === undefined
          ? {}
          : { durationMs: durationMs(active.startedAt) }
        : { durationMs: event.durationMs }),
      ...(status === 'completed' &&
      this.#context.config.watchers.job_schedule.capturePayload &&
      event.result !== undefined
        ? { result: safeSerialize(event.result) }
        : {}),
      ...(status === 'failed' && event.error !== undefined
        ? { error: safeSerialize(event.error) }
        : {}),
    }

    BatchScope.runWith(context, () => {
      this.#context.recorder.record(
        IncomingEntry.make(EntryType.SCHEDULE, content).withTags(
          `task:${event.task}`,
          `adapter:${event.adapter}`,
          status,
          ...(schedule === undefined ? [] : [`schedule:${schedule}`])
        )
      )
    })
    this.stats.tasks += 1
    this.#flush(context)
  }

  #finish(status: JobEntryContent['status'], event: QueueJobResult): void {
    safeguard('periscope.watcher.job_schedule.finished', () => {
      if (!this.#active) return
      const key = jobKey(event)
      const active = this.#activeJobs.get(key)
      this.#activeJobs.delete(key)
      const context =
        event.correlationId === undefined
          ? (active?.context ?? BatchScope.createContext('queue'))
          : active?.context.batchId === event.correlationId
            ? active.context
            : correlatedContext(event.correlationId)
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
