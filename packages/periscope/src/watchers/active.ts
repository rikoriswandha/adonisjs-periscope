/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { ExceptionWatcher } from './exception/watcher.ts'
import type { RequestWatcher } from './request/watcher.ts'

/**
 * The two watchers an application wires into its own code, and therefore the two that need a
 * rendezvous point.
 *
 * Most watchers subscribe to something and are done. These two cannot: the request watcher
 * needs a middleware in the host's server stack, and the exception watcher needs the host's
 * exception handler to call it. Both of those live in the application's source, are imported
 * long before Periscope registers anything, and must keep working when Periscope is disabled,
 * absent from the container, or never registered at all.
 *
 * So the host-side pieces — `periscope/middleware/request_watcher` and
 * `periscope/exception_reporter` — hold no state and make no container lookups. They ask this
 * module for the live watcher and, finding none, do nothing at all. That is what makes a
 * disabled Periscope literally free on the request path: an empty slot and a branch.
 *
 * The slots are module-level, which means one per process. That is correct for the thing they
 * model — an application has one server middleware stack and one exception handler — and it is
 * why {@link WatcherRegistry.cleanup} clears them: a test that boots a second application must
 * not find the first one's watcher.
 */
type ActiveWatchers = {
  request: RequestWatcher | null
  exception: ExceptionWatcher | null
}

const active: ActiveWatchers = {
  request: null,
  exception: null,
}

/**
 * Publish a watcher, or clear the slot with `null`. Called by the watcher's own
 * `register()`/`cleanup()`, never by anything else.
 */
export function setActiveWatcher<K extends keyof ActiveWatchers>(
  kind: K,
  watcher: ActiveWatchers[K]
): void {
  active[kind] = watcher
}

/**
 * The live watcher of `kind`, or `null` when Periscope is off, unregistered or shut down.
 */
export function getActiveWatcher<K extends keyof ActiveWatchers>(kind: K): ActiveWatchers[K] {
  return active[kind]
}
