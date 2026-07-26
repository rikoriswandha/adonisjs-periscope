/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { Recorder } from '../../recorder/recorder.ts'
import { safeguardAsync } from '../../safeguard.ts'

/**
 * The small boundary between the process observer and the watcher. Keeping `report` synchronous
 * is important: the entry reaches its batch before the first `await`, while the recorder is
 * exposed separately because process-level failures warrant an immediate persistence attempt.
 */
export type ProcessObserverOptions = {
  recorder: Recorder
  report(error: unknown, origin: NodeJS.UncaughtExceptionOrigin): void
}

const owners = new Set<ProcessObserverOptions>()

/**
 * Notify every registered application about a process-level failure. There is deliberately no
 * `unhandledRejection` listener: under Node's default `--unhandled-rejections=throw` policy, the
 * mere presence of that listener suppresses escalation and can turn a process that should crash
 * into one that exits successfully. `uncaughtExceptionMonitor` observes both ordinary uncaught
 * exceptions and escalated rejections, with `origin` preserving which path reached it, without
 * telling Node that either failure was handled.
 *
 * The flush is only a best-effort head start for a dying process. Node invokes its default crash
 * handler as soon as all monitor listeners return, so asynchronous I/O begun here is not
 * guaranteed to reach storage. Waiting or otherwise blocking the crash would alter the host's
 * failure semantics, which is a worse outcome than losing the final diagnostic.
 */
const uncaughtException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
  /**
   * Snapshot event-time ownership so one application's reporting side effects cannot prevent a
   * later owner from seeing the same failure by mutating the shared set during iteration.
   */
  const notifiedOwners = [...owners]

  for (const options of notifiedOwners) {
    void safeguardAsync('periscope.exception.process', async () => {
      options.report(error, origin)
      await options.recorder.flush()
    })
  }
}

/**
 * Register one application as an owner of the process-wide monitor. A process may host multiple
 * AdonisJS applications (and tests routinely do), so ownership is tracked independently even
 * though Node needs only one listener. Re-registering the same owner is idempotent.
 */
export function installProcessObservers(options: ProcessObserverOptions): void {
  if (owners.has(options)) {
    return
  }

  owners.add(options)

  if (owners.size === 1) {
    process.on('uncaughtExceptionMonitor', uncaughtException)
  }
}

/**
 * Remove only the calling application's ownership. The shared listener remains available to
 * every other application and is detached only after the final owner leaves.
 */
export function uninstallProcessObservers(options: ProcessObserverOptions): void {
  if (!owners.delete(options)) {
    return
  }

  if (owners.size === 0) {
    process.off('uncaughtExceptionMonitor', uncaughtException)
  }
}
