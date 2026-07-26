/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { multistream } from '@adonisjs/core/logger'
import type { LoggerService } from '@adonisjs/core/types'
import type { LoggerConfig, LoggerManagerConfig } from '@adonisjs/logger/types'

import { safeguard, safeguardAsync } from '../../safeguard.ts'
import { WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import { periscopeLogStream } from './stream.ts'
import type { PeriscopeLogStream } from './types.ts'

/**
 * The only pino internals the watcher touches. AdonisJS deliberately exposes the raw pino logger,
 * but pino keeps its destination behind a module-private symbol. Finding that symbol by its stable
 * description avoids making pino a direct Periscope dependency merely to import the same symbol.
 */
type PinoStreams = Record<symbol, NonNullable<LoggerConfig['destination']>>

type LoggerTarget = {
  readonly isEnabled: boolean
  readonly pino: object
}

type StreamPatch = {
  streams: PinoStreams
  symbol: symbol
  original: NonNullable<LoggerConfig['destination']>
}

/**
 * Find the destination on a root pino instance. Child instances inherit it, which is why patching
 * the manager's root also covers every existing and future `ctx.logger` child. The manager and
 * each `manager.use(name)` logger are roots of separate prototype trees and are patched separately.
 */
function streamSymbol(target: LoggerTarget): symbol {
  const symbol = Object.getOwnPropertySymbols(target.pino).find(
    (candidate) => candidate.description === 'pino.stream'
  )

  if (symbol === undefined) {
    throw new Error('Enabled AdonisJS logger has no pino.stream destination symbol')
  }

  return symbol
}

/**
 * Captures application log records by teeing a metadata-aware destination into every pino root
 * managed by AdonisJS.
 *
 * `LoggerManager` itself and `manager.use()` look interchangeable from the public logging API, but
 * they eagerly create two different pino instances. HTTP context children inherit the manager's
 * instance, while the injected `Logger` service and named loggers use the latter instances. Both
 * sides must be patched or ordinary request logs disappear depending on how the application
 * reached its logger.
 */
export class LogWatcher implements Watcher {
  readonly name = WatcherName.LOG
  readonly stats

  readonly #context: WatcherContext
  readonly #stream: PeriscopeLogStream
  readonly #patches: StreamPatch[] = []

  constructor(context: WatcherContext) {
    this.#context = context
    this.#stream = periscopeLogStream({
      recorder: context.recorder,
      level: context.config.watchers.log.level,
    })
    this.stats = this.#stream.stats
  }

  /**
   * Resolve and patch the logger lazily. The logger binding is optional in unit-test applications,
   * and checking the container first avoids turning that intentional omission into a reported
   * registration failure.
   *
   * Registration is atomic from Periscope's point of view: if one named logger has an unexpected
   * pino shape after earlier targets were patched, every earlier destination is restored before
   * the failure is swallowed. A half-installed tee would duplicate records on a later boot and,
   * worse, survive watcher cleanup.
   */
  async register(): Promise<void> {
    if (this.#patches.length > 0 || !this.#context.app.container.hasBinding('logger')) {
      return
    }

    await safeguardAsync('periscope.log.register', async () => {
      const manager = await this.#context.app.container.make('logger')
      const loggerConfig =
        this.#context.app.config.get<LoggerManagerConfig<Record<string, LoggerConfig>>>('logger')
      const patchedPinoInstances = new Set<object>()

      try {
        this.#patch(manager, patchedPinoInstances)

        /**
         * `use()` constructs named logger roots lazily and caches them forever. Eagerly visiting
         * every configured name closes both the current coverage gap and the prospective one: a
         * logger first used after registration is already the instance carrying the tee.
         *
         * The capability check is not defensive padding. `'logger'` is bound to a
         * `LoggerManager` by the framework's app provider, but the binding is a container slot
         * like any other: a test harness binds a bare `Logger` (both share `pino`, `child` and
         * `isEnabled`, neither of which is `use`), and an application is free to bind its own.
         * Patching what is there and skipping what is not is strictly better than reporting a
         * failure for a logger that has exactly one pino instance and is therefore already
         * fully covered by the patch above.
         */
        const named = 'use' in manager && typeof manager.use === 'function' ? manager : undefined

        if (named !== undefined) {
          for (const name of Object.keys(loggerConfig?.loggers ?? {})) {
            this.#patch(named.use(name as never), patchedPinoInstances)
          }
        }
      } catch (error) {
        this.cleanup()
        throw error
      }
    })
  }

  /**
   * Restore destinations in reverse installation order. Each successful restore removes its patch
   * record, so cleanup is idempotent; a truly exotic pino object whose assignment throws keeps the
   * patch queued for a later cleanup attempt rather than forgetting a tee that may still be live.
   */
  cleanup(): void {
    for (let index = this.#patches.length - 1; index >= 0; index--) {
      const patch = this.#patches[index]
      const restored = safeguard(
        'periscope.log.cleanup',
        () => {
          patch.streams[patch.symbol] = patch.original
          return true
        },
        false
      )

      if (restored) {
        this.#patches.splice(index, 1)
      }
    }
  }

  /**
   * Install one non-destructive fan-out. Both branches use `trace`: pino's multistream sorts by
   * branch level and stops walking once a threshold exceeds the record, so using Periscope's own
   * configured threshold here would silently prevent low-level records from reaching the original
   * application destination. Filtering belongs inside the metadata stream instead.
   */
  #patch(target: LoggerTarget | LoggerService, seen: Set<object>): void {
    if (!target.isEnabled || seen.has(target.pino)) {
      return
    }

    seen.add(target.pino)

    const symbol = streamSymbol(target)
    const streams = target.pino as unknown as PinoStreams
    const original = streams[symbol]

    if (original === undefined || typeof original.write !== 'function') {
      throw new Error('Enabled AdonisJS logger has an invalid pino.stream destination')
    }

    const patch = { streams, symbol, original }
    this.#patches.push(patch)

    streams[symbol] = multistream([
      { level: 'trace', stream: original },
      { level: 'trace', stream: this.#stream },
    ])
  }
}
