/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { safeguard, safeguardAsync } from '../safeguard.ts'
import { WATCHER_NAMES } from '../types.ts'
import type { Watcher, WatcherName } from '../types.ts'
import type { WatcherContext } from './context.ts'
import { EventWatcher } from './event/watcher.ts'
import { ExceptionWatcher } from './exception/watcher.ts'
import { LogWatcher } from './log/watcher.ts'
import { QueryWatcher } from './query/watcher.ts'
import { RequestWatcher } from './request/watcher.ts'

/**
 * Builds one watcher. Exported as a type so an application — or a test — can substitute a
 * watcher without the registry knowing anything about it.
 */
export type WatcherFactory = (context: WatcherContext) => Watcher

/**
 * The shipped watchers, keyed by config key.
 *
 * Iteration order is {@link WATCHER_NAMES}, which puts the request watcher first. That is not
 * cosmetic: it owns the batch every other wave-1 watcher records into, and registering it first
 * means the middleware slot is live before anything else can start producing entries.
 */
export const WATCHER_FACTORIES: Record<WatcherName, WatcherFactory> = {
  request: (context) => new RequestWatcher(context),
  query: (context) => new QueryWatcher(context),
  exception: (context) => new ExceptionWatcher(context),
  log: (context) => new LogWatcher(context),
  event: (context) => new EventWatcher(context),
}

/**
 * Resolves the enabled watchers from config, registers them, and keeps their teardown (P3.1).
 *
 * Every step runs inside `safeguard()` (§0, invariant 1). A watcher that throws while
 * subscribing takes itself out of the run and nothing else: the others still register, the
 * application still boots, and the failure is reported on the internal channel. The same holds
 * on the way out, where a watcher that cannot unsubscribe must not strand the ones behind it.
 */
export class WatcherRegistry {
  readonly #context: WatcherContext
  readonly #factories: Record<WatcherName, WatcherFactory>

  /**
   * Watchers whose `register()` was called, in registration order. Only these are cleaned up:
   * a watcher that failed to construct has nothing to unsubscribe.
   */
  readonly #registered: Watcher[] = []

  constructor(
    context: WatcherContext,
    factories: Record<WatcherName, WatcherFactory> = WATCHER_FACTORIES
  ) {
    this.#context = context
    this.#factories = factories
  }

  /**
   * The live watchers, in registration order.
   */
  get watchers(): readonly Watcher[] {
    return this.#registered
  }

  /**
   * Construct and register every enabled watcher.
   *
   * A disabled recorder registers nothing whatsoever — no emitter listener, no logger tee, no
   * process handler. "Periscope off costs nothing" has to mean the subscriptions never happen,
   * not that the entries are dropped after the fact.
   */
  async register(): Promise<void> {
    if (!this.#context.recorder.enabled) {
      return
    }

    for (const name of WATCHER_NAMES) {
      if (!this.#context.config.watchers[name].enabled) {
        continue
      }

      const watcher = safeguard(`periscope.watcher.${name}.create`, () =>
        this.#factories[name](this.#context)
      )

      if (watcher === undefined) {
        continue
      }

      /**
       * Pushed before `register()` resolves: a watcher that fails halfway through subscribing
       * may already hold half its subscriptions, and the only way those come off again is if
       * cleanup knows about it.
       */
      this.#registered.push(watcher)

      await safeguardAsync(`periscope.watcher.${name}.register`, () => watcher.register())
    }
  }

  /**
   * Unsubscribe every registered watcher, newest first, and forget them.
   *
   * Reverse order mirrors the registration dependency: the request watcher is registered first
   * because it opens the batches the others fill, so it is retired last — anything still
   * finishing has a batch to land in until the very end.
   */
  async cleanup(): Promise<void> {
    for (const watcher of this.#registered.reverse()) {
      await safeguardAsync(`periscope.watcher.${watcher.name}.cleanup`, () => watcher.cleanup?.())
    }

    this.#registered.length = 0
  }
}
