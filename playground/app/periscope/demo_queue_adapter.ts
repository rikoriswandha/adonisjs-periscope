import type {
  QueueJobEvent,
  QueueWatcherAdapter,
  QueueWatcherObserver,
} from '@rikology/adonisjs-periscope'

/**
 * A queue adapter for the playground fixture. Real applications plug BullMQ (or any queue) in via
 * `@rikology/adonisjs-periscope/watchers/bull_queue`; the playground has no Redis-backed queue, so this
 * adapter simply hands the observer to whoever wants to emit job/schedule lifecycle events —
 * the `/showcase` route uses it to prove the job and schedule watchers end-to-end.
 */
export const demoQueue: {
  observer: QueueWatcherObserver | undefined
  adapter: QueueWatcherAdapter
  dispatch(event: QueueJobEvent): QueueJobEvent
  run<T>(event: QueueJobEvent, handler: () => Promise<T>): Promise<T>
} = {
  observer: undefined,

  dispatch(event) {
    const correlation = demoQueue.observer?.dispatching?.(event)
    return correlation === undefined ? event : { ...event, ...correlation }
  },

  run(event, handler) {
    return demoQueue.observer?.wrapJob?.(event, handler) ?? handler()
  },

  adapter: {
    name: 'playground-demo',
    register(observer) {
      demoQueue.observer = observer
      return () => {
        demoQueue.observer = undefined
      }
    },
  },
}
