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
import { CacheWatcher } from './cache/watcher.ts'
import { CommandWatcher } from './command/watcher.ts'
import { DumpWatcher } from './dump/watcher.ts'
import { EventWatcher } from './event/watcher.ts'
import { ExceptionWatcher } from './exception/watcher.ts'
import { GateWatcher } from './gate/watcher.ts'
import { HttpClientWatcher } from './http_client/watcher.ts'
import { LogWatcher } from './log/watcher.ts'
import { MailWatcher } from './mail/watcher.ts'
import { ModelWatcher } from './model/watcher.ts'
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
 * Full registration iterates {@link WATCHER_NAMES}, which puts the request watcher first so its
 * middleware slot is live before the other ready-phase watchers. Provider boot is the deliberate
 * exception: it requests the model watcher alone to cover models booted before that full pass.
 */
export const WATCHER_FACTORIES: Record<WatcherName, WatcherFactory> = {
  request: (context) => new RequestWatcher(context),
  query: (context) => new QueryWatcher(context),
  exception: (context) => new ExceptionWatcher(context),
  log: (context) => new LogWatcher(context),
  event: (context) => new EventWatcher(context),
  command: (context) => new CommandWatcher(context),
  mail: (context) => new MailWatcher(context),
  cache: (context) => new CacheWatcher(context),
  model: (context) => new ModelWatcher(context),
  gate: (context) => new GateWatcher(context),
  dump: (context) => new DumpWatcher(context),
  http_client: (context) => new HttpClientWatcher(context),
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

  /**
   * Config keys already constructed by this registry. A name is claimed before its watcher
   * starts registering so overlapping or repeated lifecycle calls cannot construct a second
   * instance while the first one is still subscribing.
   */
  readonly #registeredNames = new Set<WatcherName>()

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
   * Construct and register the requested enabled watchers.
   *
   * The optional list lets the provider install the model watcher during `boot()`, before Lucid
   * models can be booted by later providers, while leaving every other watcher for `ready()`.
   * A later full registration reuses that exact retained instance and fills in only the names
   * that have not already been claimed.
   *
   * A disabled recorder registers nothing whatsoever — no optional Lucid import, emitter
   * listener, logger tee, or process handler. "Periscope off costs nothing" has to mean the
   * subscriptions never happen, not that the entries are dropped after the fact.
   */
  async register(names: readonly WatcherName[] = WATCHER_NAMES): Promise<void> {
    if (!this.#context.recorder.enabled) {
      return
    }

    for (const name of names) {
      if (this.#registeredNames.has(name) || !this.#context.config.watchers[name].enabled) {
        continue
      }

      const watcher = safeguard(`periscope.watcher.${name}.create`, () =>
        this.#factories[name](this.#context)
      )

      if (watcher === undefined) {
        continue
      }
      this.#registeredNames.add(name)

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
   * Reverse order mirrors actual subscription order. The model watcher may be registered alone
   * during provider boot, in which case it is deliberately retired last; its callbacks become
   * inert before the recorder drains, even for models that cannot remove Lucid hooks.
   */
  async cleanup(): Promise<void> {
    for (const watcher of this.#registered.reverse()) {
      await safeguardAsync(`periscope.watcher.${watcher.name}.cleanup`, () => watcher.cleanup?.())
    }

    this.#registered.length = 0
    this.#registeredNames.clear()
  }
}
