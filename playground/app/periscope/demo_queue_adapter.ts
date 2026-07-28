import type { QueueWatcherAdapter, QueueWatcherObserver } from 'adonisjs-periscope'

/**
 * A queue adapter for the playground fixture. Real applications plug BullMQ (or any queue) in via
 * `adonisjs-periscope/watchers/bull_queue`; the playground has no Redis-backed queue, so this
 * adapter simply hands the observer to whoever wants to emit job/schedule lifecycle events —
 * the `/showcase` route uses it to prove the job and schedule watchers end-to-end.
 */
export const demoQueue: {
  observer: QueueWatcherObserver | undefined
  adapter: QueueWatcherAdapter
} = {
  observer: undefined,

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
