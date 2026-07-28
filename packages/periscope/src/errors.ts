/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Periscope's error types.
 *
 * The core invariant says Periscope never throws into host-app code paths.
 * That invariant is about the *recording* path — watchers, the recorder pipeline and flushes,
 * all of which run inside `safeguard()`. Configuration and wiring are the deliberate exception:
 * a misconfigured Periscope must fail loudly at boot rather than silently record nothing, so
 * the errors below are thrown from `defineConfig()` and from store construction.
 */

/**
 * Base class for every error Periscope throws, so host applications can catch the whole family.
 */
export class PeriscopeError extends Error {
  override name = 'PeriscopeError'
}

/**
 * Thrown by `defineConfig()` when `config/periscope.ts` is invalid.
 *
 * Every problem found in a single pass is reported at once — fixing a config file one error per
 * boot is miserable, and validation is cheap.
 */
export class PeriscopeConfigError extends PeriscopeError {
  override name = 'PeriscopeConfigError'

  /**
   * Every validation failure, as `"<path>: <problem>"` strings.
   */
  readonly issues: string[]

  constructor(issues: string[]) {
    super(
      `Invalid Periscope configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}\n\n` +
        'Fix the values above in config/periscope.ts.'
    )

    this.issues = issues
  }
}

/**
 * Thrown when a configured storage driver cannot be constructed — an unknown driver name, or a
 * driver whose optional dependency is missing (for example `database` without Lucid installed).
 */
export class PeriscopeStorageError extends PeriscopeError {
  override name = 'PeriscopeStorageError'
}
