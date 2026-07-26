/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { ApplicationService } from '@adonisjs/core/types'

import { Recorder } from '../src/recorder/recorder.ts'
import { createStore } from '../src/storage/resolve.ts'
import type { StoreContext } from '../src/storage/resolve.ts'
import { PeriscopeConfigError } from '../src/errors.ts'
import { MemoryStore } from '../src/storage/memory_store.ts'
import { isRecordingEnabled } from '../src/define_config.ts'
import { registerDashboardRoutes } from '../src/http/routes.ts'
import { safeguardAsync, setInternalLogger } from '../src/safeguard.ts'
import { WatcherRegistry } from '../src/watchers/registry.ts'
import type { PeriscopeStore, ResolvedPeriscopeConfig } from '../src/types.ts'

/**
 * Every top-level block the config check below insists on. Their presence is what distinguishes
 * a `defineConfig()` result from a hand-written object literal that skipped validation and
 * default resolution.
 */
const REQUIRED_CONFIG_BLOCKS = [
  'storage',
  'recording',
  'redact',
  'hooks',
  'watchers',
  'dashboard',
] as const

/**
 * Periscope participates only in application processes that can either record host activity or
 * manage the durable store. The `adonisrc.ts` descriptor is the primary gate; this defensive check
 * keeps a hand-written, unconditional provider registration from attaching observers in REPL and
 * unknown processes.
 */
const PROVIDER_ENVIRONMENTS: Record<string, true> = {
  web: true,
  console: true,
  test: true,
}

/**
 * The Periscope service provider, registered by an application under `adonisrc.ts#providers`.
 *
 * Registration order matters. Periscope is meant to be registered *early*, so its terminating
 * hook is also registered early. Adonis runs those hooks in reverse order: later host hooks can
 * finish producing entries before Periscope drains them, all before provider shutdown begins.
 */
export default class PeriscopeProvider {
  /**
   * The resolved singleton, captured in the container factory. Kept so `shutdown` can wind down
   * a recorder that exists without *creating* one that never did — an application that boots and
   * exits without touching Periscope should not build a store on its way out.
   */
  #recorder: Recorder | null = null

  /**
   * The store, kept on the provider because it is the provider — not the recorder — that owns its
   * lifetime. `Recorder.shutdown()` deliberately does not close it: the ace commands and the
   * dashboard read through the same instance and outlive a recorder flush.
   */
  #store: PeriscopeStore | null = null

  /**
   * The watcher registry, created in `ready()` once the recorder exists. Kept so shutdown can
   * unsubscribe exactly what was subscribed — a watcher that stays attached to the emitter after
   * the application terminates is a leak in production and cross-talk between suites in tests.
   */
  #watchers: WatcherRegistry | null = null

  /**
   * The single teardown shared by the application `terminating` hook and provider shutdown.
   *
   * Periscope is normally an early provider, so its provider shutdown runs after Lucid's. The
   * terminating phase runs before every provider shutdown, while Lucid and the other watched host
   * services are still usable. Memoising the work lets the later provider shutdown safely await
   * the already-completed teardown instead of flushing through a closed service or closing twice.
   */
  #shutdownPromise: Promise<void> | null = null

  #terminatingHookRegistered = false
  #routesRegistered = false

  constructor(protected app: ApplicationService) {}

  /**
   * Bind the recorder as a singleton, resolved from `config/periscope.ts`.
   */
  register() {
    if (!this.#terminatingHookRegistered) {
      /**
       * Application terminating hooks run in reverse registration order. Registering from this
       * early provider preserves entries produced by hooks registered later: those hooks run
       * first, then Periscope unsubscribes, drains, and closes while host providers are alive.
       */
      this.app.terminating(() => this.#teardown())
      this.#terminatingHookRegistered = true
    }

    this.app.container.singleton(Recorder, async () => {
      const config = this.#resolveConfig()

      /**
       * Recording and store selection are related, but not identical. Console processes must open
       * the configured store even when recording is environment-disabled: maintenance commands
       * run in short-lived console applications and must operate on the same durable data as the
       * web process. Every other disabled process retains the cheap, side-effect-free MemoryStore
       * path.
       */
      const environment = this.app.getEnvironment()
      const enabled =
        PROVIDER_ENVIRONMENTS[environment] === true &&
        isRecordingEnabled(config, {
          nodeEnv: this.app.nodeEnvironment,
          periscopeEnabled: process.env.PERISCOPE_ENABLED,
        })
      const useConfiguredStore = enabled || environment === 'console'

      this.#store = useConfiguredStore
        ? await createStore(config, this.#storeContext())
        : new MemoryStore({ maxEntries: config.storage.maxEntries })

      this.#recorder = new Recorder({ config, store: this.#store, enabled })

      return this.#recorder
    })
  }

  /**
   * The slice of the application the storage drivers are allowed to see.
   *
   * `database` is populated only when the host has actually bound Lucid, so the container lookup
   * lives here and the explanation of what to do about a missing one lives in `createStore` —
   * the driver knows why it needs a database, the provider knows where one would come from.
   */
  #storeContext(): StoreContext {
    const context: StoreContext = {
      tmpPath: (...paths: string[]) => this.app.tmpPath(...paths),
    }

    if (this.app.container.hasBinding('lucid.db')) {
      context.database = () => this.app.container.make('lucid.db')
    }

    return context
  }

  /**
   * Register dashboard routes only in the HTTP process. Console, test-runner and REPL processes
   * must not resolve the router or expose an HTTP surface.
   */
  async start() {
    if (this.app.getEnvironment() !== 'web' || this.#routesRegistered) {
      return
    }

    const config = this.#resolveConfig()
    const recorder = await this.app.container.make(Recorder)
    const router = await this.app.container.make('router')

    registerDashboardRoutes({
      router,
      recorder,
      config,
      environment: {
        nodeEnv: this.app.nodeEnvironment,
        periscopeEnabled: () => process.env.PERISCOPE_ENABLED,
      },
    })

    this.#routesRegistered = true
  }

  /**
   * Resolve the recorder, start the ambient batch rotation — the timer that drains everything
   * recorded outside a request, command or job — and register the watchers.
   *
   * Resolving here rather than lazily is deliberate: it is what makes an invalid
   * `config/periscope.ts` fail at boot with a clear error (P1.5) instead of on whichever request
   * first happens to record something.
   *
   * Watchers come last, and only once the recorder is running. They subscribe to live sources —
   * the emitter, the logger's pino stream, the process — so the thing they feed has to exist and
   * be draining before the first event can arrive.
   */
  async ready() {
    const recorder = await this.app.container.make(Recorder)

    /**
     * The internal reporter is not a watcher and does not patch a logger destination. Wiring it
     * for both enabled and disabled recorders ensures configured-store teardown failures (notably
     * from console maintenance processes) are still reported through the host logger.
     */
    await this.#wireInternalLogger()

    if (!recorder.enabled) {
      return
    }

    recorder.start()

    await this.#registerWatchers(recorder)
  }

  /**
   * Build the watcher registry and let it subscribe (P3.1).
   *
   * A disabled recorder registers nothing at all — the registry short-circuits — so there is no
   * emitter listener, no logger tee and no process handler to account for. That is what makes
   * "Periscope off" free rather than merely quiet, and P5.1 asserts it by counting listeners.
   *
   * `dev` is resolved once, here, as "not production". Watchers use it to gate the expensive
   * developer-facing captures (query call sites, exception code frames), and resolving it in one
   * place keeps `NODE_ENV=test` behaving like a developer's machine everywhere at once.
   */
  async #registerWatchers(recorder: Recorder) {
    if (!recorder.enabled) {
      return
    }

    if (this.#watchers !== null) {
      /**
       * `ready()` may be called more than once by application tooling and tests. The recorder's
       * ambient rotation is already idempotent, but every watcher subscription is independent:
       * replacing this registry would leave its listeners alive with no object left to clean
       * them up. Keeping the first registry makes repeated readiness a no-op for listeners and
       * preserves the one registry shutdown still owns.
       */
      return
    }

    await safeguardAsync('periscope.provider.watchers', async () => {
      const emitter = await this.app.container.make('emitter')

      this.#watchers = new WatcherRegistry({
        app: this.app,
        emitter,
        recorder,
        config: this.#resolveConfig(),
        dev: !this.app.inProduction,
      })

      await this.#watchers.register()
    })
  }

  /**
   * Unsubscribe the watchers, flush what is still buffered, then release the store.
   *
   * Ordering is the whole point, and it runs strictly backwards from `ready()`. The watchers go
   * first so nothing new is recorded while the recorder is winding down — a log line emitted by
   * a shutting-down provider must not land in a batch that is already being flushed. Then
   * `Recorder.shutdown()` stops its lifecycle polls and ambient rotation and performs the final
   * flush, which writes through the store, so the store can only be closed afterwards. The
   * internal logger is unhooked last, for the same reason: a flush that fails on the way out is
   * exactly the failure worth reporting.
   *
   * The application-level terminating hook starts this sequence before any provider shutdown.
   * `shutdown()` remains the provider lifecycle fallback and reuses the same promise.
   */
  async shutdown() {
    await this.#teardown()
  }

  #teardown(): Promise<void> {
    this.#shutdownPromise ??= this.#performTeardown()
    return this.#shutdownPromise
  }

  async #performTeardown(): Promise<void> {
    try {
      /**
       * Keep teardown strictly ordered while isolating every stage. A failed watcher cleanup must
       * not prevent the final recorder drain, and a rejected close must never escape into host
       * shutdown.
       */
      await safeguardAsync('periscope.provider.watchers.cleanup', () => this.#watchers?.cleanup())
      await safeguardAsync('periscope.provider.recorder.shutdown', () => this.#recorder?.shutdown())
      await safeguardAsync('periscope.provider.store.close', () => this.#store?.close())
    } finally {
      this.#watchers = null
      this.#recorder = null
      this.#store = null

      /**
       * Restores the standalone default reporter. A terminated application's logger may be writing
       * to a closed destination, and in tests a leaked binding would have one suite's failures
       * reported through another's logger.
       */
      setInternalLogger(null)
    }
  }

  /**
   * Point Periscope's swallowed-failure reporter at the application logger (P1.3).
   *
   * `safeguard()` is what keeps Periscope from throwing into host code (§0, invariant 1), but a
   * swallowed failure that is also silent is indistinguishable from "nothing happened": a store
   * that rejects every write produces an empty dashboard and not one diagnostic line. The
   * standalone default in `safeguard.ts` cannot fix that on its own — it has no application to
   * borrow a logger from — so the provider, which does, hooks the real one up here.
   *
   * The `periscope.internal` name is load-bearing rather than cosmetic: P3.5's LogWatcher
   * excludes that channel by name, and that exclusion is the only thing standing between a
   * failing store and a feedback loop where Periscope's own error logs become Periscope entries
   * that fail to write, which logs another error.
   *
   * Everything here is defensive. An application can boot without a logger binding at all (unit
   * tests do), and wiring up diagnostics must never be the reason a host fails to start — so a
   * missing or broken logger leaves the silent default in place and boot continues.
   */
  async #wireInternalLogger() {
    if (!this.app.container.hasBinding('logger')) {
      return
    }

    await safeguardAsync('periscope.provider.logger', async () => {
      const logger = await this.app.container.make('logger')
      const internal = logger.child({ name: 'periscope.internal' })

      setInternalLogger((label, error) => internal.error({ err: error }, label))
    })
  }

  /**
   * Read `config/periscope.ts` and confirm it went through `defineConfig()`.
   *
   * The check is not paranoia: `defineConfig` is where validation and default resolution happen,
   * and every consumer downstream — recorder, redactor, storage drivers — reads the dense resolved
   * shape without fallbacks. A raw object literal would typecheck at the config file's call site
   * and then fail deep inside the recorder with an unhelpful `undefined` error.
   */
  #resolveConfig(): ResolvedPeriscopeConfig {
    const config = this.app.config.get<ResolvedPeriscopeConfig | undefined>('periscope')

    if (config === undefined) {
      throw new PeriscopeConfigError([
        'config/periscope.ts: missing. Run "node ace add periscope", or remove the Periscope ' +
          'provider from adonisrc.ts.',
      ])
    }

    const missing = REQUIRED_CONFIG_BLOCKS.filter((block) => config[block] === undefined)

    if (missing.length > 0) {
      throw new PeriscopeConfigError([
        `config/periscope.ts: not resolved — the ${missing.join(', ')} block(s) are missing. ` +
          'Export defineConfig({ ... }) from the file rather than a plain object.',
      ])
    }

    return config
  }
}
