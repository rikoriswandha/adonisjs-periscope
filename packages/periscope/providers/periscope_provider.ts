/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { ApplicationService } from '@adonisjs/core/types'

import { Recorder } from '../src/recorder/recorder.ts'
import { createStore } from '../src/storage/resolve.ts'
import { PeriscopeConfigError } from '../src/errors.ts'
import { MemoryStore } from '../src/storage/memory_store.ts'
import { isRecordingEnabled } from '../src/define_config.ts'
import { safeguardAsync, setInternalLogger } from '../src/safeguard.ts'
import type { PeriscopeStore, ResolvedPeriscopeConfig } from '../src/types.ts'

/**
 * Every top-level block the config check below insists on. Their presence is what distinguishes
 * a `defineConfig()` result from a hand-written object literal that skipped validation and
 * default resolution.
 */
const REQUIRED_CONFIG_BLOCKS = ['storage', 'recording', 'redact', 'hooks'] as const

/**
 * The Periscope service provider, registered by an application under `adonisrc.ts#providers`.
 *
 * Registration order matters in both directions. AdonisJS boots providers in declaration order and
 * shuts them down in reverse, so Periscope is meant to be registered *early*: its shutdown then
 * runs *late*, after the providers whose work it is watching have stopped producing entries.
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

  constructor(protected app: ApplicationService) {}

  /**
   * Bind the recorder as a singleton, resolved from `config/periscope.ts`.
   */
  register() {
    this.app.container.singleton(Recorder, () => {
      const config = this.#resolveConfig()

      /**
       * The environment gate is consulted exactly once, here, and settles two questions at the
       * same time: whether the recorder records, and whether the configured driver is built at
       * all.
       */
      const enabled = isRecordingEnabled(config, {
        nodeEnv: this.app.nodeEnvironment,
        periscopeEnabled: process.env.PERISCOPE_ENABLED,
      })

      /**
       * A disabled Periscope never touches the configured driver — it gets a `MemoryStore`
       * instead, whatever `storage.driver` says.
       *
       * This is what makes "disabled" actually free (plan §0: zero cost when off). A disabled
       * recorder drops every entry in `record()`, so it never buffers, never flushes and arms no
       * ambient timer; nothing it owns can reach the store. The other reader of the store, the
       * dashboard, is gated off by this very same switch (P4.1). Building the real driver would
       * therefore open a sqlite file, load a native module or hold a database connection purely
       * so that nothing could be written to it — and today it is worse than wasteful: with the
       * `sqlite-local` default, `createStore` throws until Phase 2 lands, which would take the
       * *host application* down at boot because Periscope is switched off. A `MemoryStore` is
       * three empty `Map`s and cannot fail.
       */
      this.#store = enabled
        ? createStore(config)
        : new MemoryStore({ maxEntries: config.storage.maxEntries })

      this.#recorder = new Recorder({ config, store: this.#store, enabled })

      return this.#recorder
    })
  }

  /**
   * Resolve the recorder and start the ambient batch rotation — the timer that drains everything
   * recorded outside a request, command or job.
   *
   * Resolving here rather than lazily is deliberate: it is what makes an invalid
   * `config/periscope.ts` fail at boot with a clear error (P1.5) instead of on whichever request
   * first happens to record something.
   */
  async ready() {
    await this.#wireInternalLogger()

    const recorder = await this.app.container.make(Recorder)
    recorder.start()
  }

  /**
   * Flush what is still buffered, then release the store.
   *
   * Ordering is the whole point: `Recorder.shutdown()` stops the ambient rotation and performs a
   * final flush, which writes through the store, so the store can only be closed afterwards. The
   * internal logger is unhooked last, for the same reason: a flush that fails on the way out is
   * exactly the failure worth reporting.
   */
  async shutdown() {
    await this.#recorder?.shutdown()
    await this.#store?.close()

    this.#recorder = null
    this.#store = null

    /**
     * Restores the standalone default reporter. A terminated application's logger may be writing
     * to a closed destination, and in tests a leaked binding would have one suite's failures
     * reported through another's logger.
     */
    setInternalLogger(null)
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
