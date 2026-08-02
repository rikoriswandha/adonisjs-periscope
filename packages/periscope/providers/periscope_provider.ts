/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { hostname } from 'node:os'
import type { ApplicationService } from '@adonisjs/core/types'

import { createInProcessFanout } from '../src/fanout.ts'
import { Recorder } from '../src/recorder/recorder.ts'
import { createStore } from '../src/storage/resolve.ts'
import type { StoreContext } from '../src/storage/resolve.ts'
import { PeriscopeConfigError } from '../src/errors.ts'
import { MemoryStore } from '../src/storage/memory_store.ts'
import { isRecordingEnabled } from '../src/define_config.ts'
import { registerDashboardRoutes } from '../src/http/routes.ts'
import { safeguardAsync, setInternalLogger } from '../src/safeguard.ts'
import { WatcherRegistry } from '../src/watchers/registry.ts'
import { type EntryType, WatcherName } from '../src/types.ts'
import type { FlushFanout, PeriscopeStore, ResolvedPeriscopeConfig } from '../src/types.ts'

const RETENTION_INTERVAL_MS = 15 * 60 * 1_000
const MAINTENANCE_LEASE = 'maintenance-lease'
const WORKER_IDENTITY = `${process.pid}@${hostname()}`

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
   * Automatic retention is provider-owned because it shares the configured store's lifetime.
   * Both timers are unref'd so they can never keep a console process or shutdown alive.
   */
  #retentionInitialRun: NodeJS.Timeout | undefined
  #retentionInterval: NodeJS.Timeout | undefined
  #retentionPrune: Promise<void> | null = null

  /**
   * The fanout is provider-owned because application adapters may hold sockets. Its bridge stays
   * live through the recorder's final flush, then teardown unsubscribes and closes the adapter.
   */
  #fanout: FlushFanout | null = null
  #fanoutSetup: Promise<FlushFanout> | null = null
  #fanoutUnsubscribe: (() => void) | null = null

  /**
   * The watcher registry, created as soon as an enabled recorder needs its early model watcher.
   * The same registry fills in the remaining watchers at `ready()` and owns every cleanup in
   * reverse registration order.
   */
  #watchers: WatcherRegistry | null = null

  /**
   * Coalesces overlapping lifecycle calls while the emitter is being resolved. Adonis invokes
   * provider phases serially, but application tooling and focused tests can call them directly.
   */
  #watchersSetup: Promise<WatcherRegistry | undefined> | null = null

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
   * Install only the model watcher before later providers can boot application models.
   *
   * The recorder is intentionally not started yet. Its ambient batch exists from construction,
   * so model hooks fired between `boot()` and `ready()` can buffer safely without starting the
   * rotation and pause-state timers early.
   */
  async boot() {
    const recorder = await this.app.container.make(Recorder)
    await this.#ensureFanout(recorder, this.#resolveConfig())

    if (!recorder.enabled) {
      return
    }

    await this.#registerWatchers(recorder, [WatcherName.MODEL])
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
      app: this.app,
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
    const fanout = await this.#ensureFanout(recorder, config)
    const router = await this.app.container.make('router')

    registerDashboardRoutes({
      router,
      recorder,
      config,
      fanout,
      environment: {
        nodeEnv: this.app.nodeEnvironment,
        periscopeEnabled: () => process.env.PERISCOPE_ENABLED,
      },
    })

    this.#routesRegistered = true
  }

  /**
   * Build one process-local fanout seam and bridge recorder flushes into it exactly once.
   *
   * Application factories are isolated because a broken live-dashboard adapter must never stop
   * recording or application boot; the in-process adapter remains a useful same-worker fallback.
   */
  async #ensureFanout(recorder: Recorder, config: ResolvedPeriscopeConfig): Promise<FlushFanout> {
    if (this.#fanout !== null) {
      return this.#fanout
    }

    this.#fanoutSetup ??= (async () => {
      let fanout = createInProcessFanout()

      const factory = config.dashboard.fanout
      if (factory !== undefined) {
        fanout =
          (await safeguardAsync('periscope.provider.fanout.create', () =>
            factory({ app: this.app, config })
          )) ?? fanout
      }

      this.#fanout = fanout
      this.#fanoutUnsubscribe = recorder.subscribeFlushed((event) => {
        void safeguardAsync('periscope.provider.fanout.publish', () => fanout.publish(event))
      })

      return fanout
    })()

    return this.#fanoutSetup
  }

  /**
   * Resolve the recorder, start the ambient batch rotation — the timer that drains everything
   * recorded outside a request, command or job — and register the watchers not already installed
   * during `boot()`.
   *
   * Resolving here as a fallback is deliberate: direct lifecycle tests and application tooling
   * may call `ready()` without first calling `boot()`. Invalid `config/periscope.ts` files still
   * fail with a clear error instead of waiting for the first recorded event.
   *
   * The remaining watchers come last, and only once the recorder is running. They subscribe to
   * live sources — the emitter, the logger's pino stream, the process — so the thing they feed has
   * to exist and be draining before the first event can arrive.
   */
  async ready() {
    const recorder = await this.app.container.make(Recorder)
    await this.#ensureFanout(recorder, this.#resolveConfig())

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

    this.#startRetention(recorder)
  }

  /**
   * Run retention under a short-lived store flag shared by every application worker.
   *
   * This lease is deliberately best-effort rather than a distributed lock: two workers can both
   * observe an empty flag before either writes it. That lost race only causes duplicate `prune`
   * calls, which are harmless, while avoiding a driver-specific locking primitive in the store
   * contract.
   */
  #startRetention(recorder: Recorder): void {
    const retention = this.#resolveConfig().storage.retention
    if (retention === undefined || this.#retentionInterval !== undefined) {
      return
    }

    const prune = () => {
      this.#retentionInitialRun = undefined

      if (this.#retentionPrune !== null) {
        return
      }

      const pruning = safeguardAsync('periscope.provider.retention.prune', () =>
        recorder.mute(async () => {
          const lease = await recorder.store.getFlag(MAINTENANCE_LEASE)
          if (lease !== null && lease !== WORKER_IDENTITY) {
            return
          }

          const now = Date.now()
          await recorder.store.setFlag(MAINTENANCE_LEASE, WORKER_IDENTITY, {
            expiresAt: new Date(now + 2 * RETENTION_INTERVAL_MS),
          })

          const perTypeBefore: Partial<Record<EntryType, Date>> = {}
          for (const [type, window] of Object.entries(retention.perType)) {
            perTypeBefore[type as EntryType] = new Date(now - window.hours * 60 * 60 * 1_000)
          }

          await recorder.store.prune({
            before: new Date(now - retention.hours * 60 * 60 * 1_000),
            perTypeBefore,
            keepExceptions: retention.keepExceptions,
          })
        })
      ).then(() => {})
      this.#retentionPrune = pruning

      void pruning.finally(() => {
        if (this.#retentionPrune === pruning) {
          this.#retentionPrune = null
        }
      })
    }

    this.#retentionInitialRun = setTimeout(prune, 0)
    this.#retentionInitialRun.unref()
    this.#retentionInterval = setInterval(prune, RETENTION_INTERVAL_MS)
    this.#retentionInterval.unref()
  }

  #stopRetention(): void {
    clearTimeout(this.#retentionInitialRun)
    clearInterval(this.#retentionInterval)
    this.#retentionInitialRun = undefined
    this.#retentionInterval = undefined
  }

  /**
   * Register the requested watchers through the one registry owned by this provider.
   *
   * A disabled recorder never resolves the emitter or constructs a watcher. In particular,
   * `boot()` never reaches ModelWatcher's optional Lucid import on that path.
   */
  async #registerWatchers(recorder: Recorder, names?: readonly WatcherName[]) {
    if (!recorder.enabled) {
      return
    }

    const watchers = await this.#watcherRegistry(recorder)
    await watchers?.register(names)
  }

  async #watcherRegistry(recorder: Recorder): Promise<WatcherRegistry | undefined> {
    if (this.#watchers !== null) {
      return this.#watchers
    }

    this.#watchersSetup ??= safeguardAsync('periscope.provider.watchers', async () => {
      const emitter = await this.app.container.make('emitter')

      return new WatcherRegistry({
        app: this.app,
        emitter,
        recorder,
        config: this.#resolveConfig(),
        dev: !this.app.inProduction,
      })
    })

    const watchers = await this.#watchersSetup
    this.#watchersSetup = null

    if (watchers !== undefined) {
      this.#watchers ??= watchers
    }

    return this.#watchers ?? undefined
  }

  /**
   * Unsubscribe the watchers, flush what is still buffered, then release the store.
   *
   * Ordering is the whole point, and it runs strictly backwards from watcher registration.
   * Watchers go first so nothing new is recorded while the recorder is winding down. A log line
   * emitted by a shutting-down provider must not land in a batch that is already being flushed.
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
      this.#stopRetention()
      await this.#retentionPrune
      await safeguardAsync('periscope.provider.watchers.cleanup', () => this.#watchers?.cleanup())
      await safeguardAsync('periscope.provider.recorder.shutdown', () => this.#recorder?.shutdown())
      await this.#fanoutSetup
      this.#fanoutUnsubscribe?.()
      await safeguardAsync('periscope.provider.fanout.close', () => this.#fanout?.close?.())
      await safeguardAsync('periscope.provider.store.close', () => this.#store?.close())
    } finally {
      this.#watchers = null
      this.#recorder = null
      this.#store = null
      this.#watchersSetup = null
      this.#retentionPrune = null
      this.#fanout = null
      this.#fanoutSetup = null
      this.#fanoutUnsubscribe = null

      /**
       * Restores the standalone default reporter. A terminated application's logger may be writing
       * to a closed destination, and in tests a leaked binding would have one suite's failures
       * reported through another's logger.
       */
      setInternalLogger(null)
    }
  }

  /**
   * Point Periscope's swallowed-failure reporter at the application logger.
   *
   * `safeguard()` is what keeps Periscope from throwing into host code (§0, invariant 1), but a
   * swallowed failure that is also silent is indistinguishable from "nothing happened": a store
   * that rejects every write produces an empty dashboard and not one diagnostic line. The
   * standalone default in `safeguard.ts` cannot fix that on its own — it has no application to
   * borrow a logger from — so the provider, which does, hooks the real one up here.
   *
   * The `periscope.internal` name is load-bearing rather than cosmetic: LogWatcher
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
