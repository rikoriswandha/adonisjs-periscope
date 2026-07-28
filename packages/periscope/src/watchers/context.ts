/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { ApplicationService, EmitterService } from '@adonisjs/core/types'

import type { Recorder } from '../recorder/recorder.ts'
import type { ResolvedPeriscopeConfig } from '../types.ts'

/**
 * Everything a watcher is allowed to see.
 *
 * Watchers receive this object rather than the application, so that what a watcher can reach is
 * a written-down list rather than "whatever is in the container". `app` is still here — the log
 * watcher genuinely needs the logger binding — but the pieces every watcher uses are hoisted out
 * of it, which is what lets a unit test construct a watcher against a fake emitter and a
 * memory-backed recorder without booting anything.
 */
export type WatcherContext = {
  app: ApplicationService

  /**
   * The application emitter — the same instance Lucid, the HTTP server, mail and session all
   * emit on, resolved once by the registry.
   */
  emitter: EmitterService

  recorder: Recorder

  config: ResolvedPeriscopeConfig

  /**
   * Whether `dev`-gated captures (query call sites, exception code frames) run.
   *
   * Resolved once, as "not production", which is the same rule AdonisJS's own exception handler
   * uses for its `debug` flag. `NODE_ENV=test` therefore behaves like a developer's machine,
   * which is what makes those captures testable at all.
   */
  dev: boolean
}
