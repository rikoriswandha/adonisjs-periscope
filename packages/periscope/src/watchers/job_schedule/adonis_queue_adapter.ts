import type {
  QueueJobEvent,
  QueueJobResult,
  QueueWatcherAdapter,
  QueueWatcherObserver,
  QueueWatcherRegistrationOptions,
} from '../../types.ts'

type TraceHandlers<Message extends object> = {
  start?(message: Message): void
  asyncEnd?(message: Message): void
  error?(message: Message): void
}

type TraceChannel<Message extends object> = {
  subscribe(handlers: TraceHandlers<Message>): void
  unsubscribe(handlers: TraceHandlers<Message>): void
}

type QueueJob = {
  id?: unknown
  name?: unknown
  payload?: unknown
  attempts?: unknown
  scheduleId?: unknown
  traceContext?: unknown
}

type DispatchMessage = {
  jobs?: unknown
  queue?: unknown
  delay?: unknown
}

type ExecuteMessage = {
  job?: unknown
  queue?: unknown
  status?: unknown
  duration?: unknown
  error?: unknown
  nextRetryAt?: unknown
  result?: unknown
}

type QueueTracingChannels = {
  dispatch: TraceChannel<DispatchMessage>
  execute: TraceChannel<ExecuteMessage>
}

const CORRELATION_TRACE_KEY = 'periscope.queue_correlation_id'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function asTraceChannel<Message extends object>(value: unknown): TraceChannel<Message> | undefined {
  const channel = asRecord(value)
  if (channel === undefined) return undefined
  if (typeof channel.subscribe !== 'function' || typeof channel.unsubscribe !== 'function') {
    return undefined
  }

  return channel as TraceChannel<Message>
}

function tracingChannels(queuePackage: unknown): QueueTracingChannels | undefined {
  const exported = asRecord(queuePackage)
  const channels = asRecord(exported?.tracingChannels)
  const dispatch = asTraceChannel<DispatchMessage>(channels?.dispatchChannel)
  const execute = asTraceChannel<ExecuteMessage>(channels?.executeChannel)

  return dispatch === undefined || execute === undefined ? undefined : { dispatch, execute }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function jobEvent(
  adapter: string,
  message: { job?: unknown; queue?: unknown },
  capturePayload: boolean
): QueueJobEvent | undefined {
  const job = asRecord(message.job) as QueueJob | undefined
  if (job === undefined || typeof job.id !== 'string' || typeof message.queue !== 'string') {
    return undefined
  }

  const rawAttempts = finiteNumber(job.attempts)
  const correlationId = asRecord(job.traceContext)?.[CORRELATION_TRACE_KEY]
  return {
    adapter,
    queue: message.queue,
    jobId: job.id,
    ...(typeof job.name === 'string' ? { name: job.name } : {}),
    ...(typeof correlationId === 'string' ? { correlationId } : {}),
    ...(rawAttempts === undefined ? {} : { attempts: Math.max(0, Math.floor(rawAttempts)) + 1 }),
    ...(capturePayload && job.payload !== undefined ? { payload: job.payload } : {}),
  }
}

function scheduledAt(value: unknown): Date | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value !== 'string' && typeof value !== 'number') return undefined

  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : undefined
}

function notify<T>(callback: () => T): T | undefined {
  try {
    return callback()
  } catch {
    // diagnostics_channel subscribers must never throw into the queue worker.
    return undefined
  }
}

/**
 * Observes the diagnostics channels published by the experimental `@adonisjs/queue` package.
 * Importing the optional peer is deferred until registration, so applications without the package
 * pay no startup cost and registration degrades to a silent no-op.
 */
export class AdonisQueueAdapter implements QueueWatcherAdapter {
  readonly name = 'adonisjs-queue'

  async register(
    observer: QueueWatcherObserver,
    options: QueueWatcherRegistrationOptions = { capturePayload: false }
  ): Promise<void | (() => void)> {
    let channels: QueueTracingChannels | undefined
    try {
      // The host package is an optional peer and cannot be loaded at module evaluation time.
      channels = tracingChannels(await import('@adonisjs/queue'))
    } catch {
      return
    }
    if (channels === undefined) return

    let active = true
    const dispatchStartedAt = new WeakMap<DispatchMessage, number>()
    const failedDispatches = new WeakSet<DispatchMessage>()
    const failedExecutions = new WeakSet<ExecuteMessage>()

    const dispatchHandlers: TraceHandlers<DispatchMessage> = {
      start: (message) => {
        if (!active || !Array.isArray(message.jobs)) return
        dispatchStartedAt.set(message, Date.now())

        for (const value of message.jobs) {
          const job = asRecord(value) as QueueJob | undefined
          const event = jobEvent(this.name, { job, queue: message.queue }, options.capturePayload)
          if (job === undefined || event === undefined) continue

          const correlation = notify(() => observer.dispatching?.(event))
          if (correlation === undefined) continue

          /**
           * @adonisjs/queue already transports this string map for OpenTelemetry propagation.
           * A namespaced key keeps Periscope's opaque id with the serialized job without changing
           * application payloads or depending on a storage-driver-specific metadata column.
           */
          job.traceContext = {
            ...asRecord(job.traceContext),
            [CORRELATION_TRACE_KEY]: correlation.correlationId,
          }
        }
      },
      error: (message) => {
        failedDispatches.add(message)
        dispatchStartedAt.delete(message)
      },
      asyncEnd: (message) => {
        if (!active || failedDispatches.has(message) || !Array.isArray(message.jobs)) return

        const delay = finiteNumber(message.delay)
        const dispatchedAt = dispatchStartedAt.get(message) ?? Date.now()
        dispatchStartedAt.delete(message)

        for (const value of message.jobs) {
          const job = asRecord(value) as QueueJob | undefined
          const isRecurring = typeof job?.scheduleId === 'string'
          if ((delay === undefined || delay <= 0) && !isRecurring) continue

          const event = jobEvent(this.name, { job, queue: message.queue }, options.capturePayload)
          if (event === undefined) continue

          notify(() =>
            observer.scheduled({
              ...event,
              scheduledAt: new Date(dispatchedAt + Math.max(0, delay ?? 0)),
            })
          )
        }
      },
    }

    const executeHandlers: TraceHandlers<ExecuteMessage> = {
      start: (message) => {
        if (!active) return
        const event = jobEvent(this.name, message, options.capturePayload)
        if (event !== undefined) notify(() => observer.started(event))
      },
      error: (message) => {
        if (!active) return
        failedExecutions.add(message)
        const event = jobEvent(this.name, message, options.capturePayload)
        if (event === undefined) return

        notify(() =>
          observer.failed({
            ...event,
            ...(message.error === undefined ? {} : { error: message.error }),
          })
        )
      },
      asyncEnd: (message) => {
        if (!active || failedExecutions.has(message)) return
        const event = jobEvent(this.name, message, options.capturePayload)
        if (event === undefined) return

        const duration = finiteNumber(message.duration)
        const result: QueueJobResult = {
          ...event,
          ...(duration === undefined ? {} : { durationMs: Math.max(0, duration) }),
          ...(options.capturePayload && message.result !== undefined
            ? { result: message.result }
            : {}),
          ...(message.error === undefined ? {} : { error: message.error }),
        }

        if (message.status === 'completed') {
          notify(() => observer.completed(result))
        } else if (message.status === 'failed') {
          notify(() => observer.failed(result))
        } else if (message.status === 'retrying') {
          const retryAt = scheduledAt(message.nextRetryAt)
          notify(() =>
            observer.scheduled({
              ...event,
              ...(retryAt === undefined ? {} : { scheduledAt: retryAt }),
            })
          )
        }
      },
    }

    let dispatchSubscribed = false
    let executeSubscribed = false
    try {
      channels.dispatch.subscribe(dispatchHandlers)
      dispatchSubscribed = true
      channels.execute.subscribe(executeHandlers)
      executeSubscribed = true
    } catch {
      active = false
      if (executeSubscribed) {
        try {
          channels.execute.unsubscribe(executeHandlers)
        } catch {
          // Partial registration still degrades silently.
        }
      }
      if (dispatchSubscribed) {
        try {
          channels.dispatch.unsubscribe(dispatchHandlers)
        } catch {
          // Partial registration still degrades silently.
        }
      }
      return
    }

    return () => {
      if (!active) return
      active = false
      try {
        channels.execute.unsubscribe(executeHandlers)
      } catch {
        // Optional diagnostics teardown must never affect application shutdown.
      }
      try {
        channels.dispatch.unsubscribe(dispatchHandlers)
      } catch {
        // Optional diagnostics teardown must never affect application shutdown.
      }
    }
  }
}
