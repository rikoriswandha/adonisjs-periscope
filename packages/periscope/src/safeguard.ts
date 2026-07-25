/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Implementation plan §0, invariant 1: "Periscope never throws into host-app code paths".
 *
 * Every watcher, hook and recorder entry point runs inside `safeguard`. A failure inside
 * Periscope is reported to an internal logger and then dropped — the host application never
 * observes it.
 *
 * The internal reporter itself is hardened:
 *
 * - It can never throw (a throwing custom logger is swallowed).
 * - It can never re-enter (a logger that fails while reporting cannot trigger a second report).
 * - The default reporter is silent unless `PERISCOPE_DEBUG` is set, writes to stderr rather
 *   than `console.error` (so it does not pass through the host's log pipeline, which Periscope
 *   itself watches), and performs no outbound I/O whatsoever.
 */

/**
 * Receives failures caught by `safeguard`. Implementations must not throw; if one does, the
 * error is swallowed.
 */
export type InternalLogger = (label: string, error: unknown) => void

/**
 * Re-entrancy latch. Set while the internal logger runs so a failure inside the reporter can
 * never trigger another report.
 */
let reporting = false

/**
 * Default reporter: silent unless `PERISCOPE_DEBUG` is set, and never anything but a local
 * stderr write. Unknown thrown values are rendered without invoking user code beyond the
 * standard `Error` properties.
 */
const defaultInternalLogger: InternalLogger = (label, error) => {
  if (!process.env.PERISCOPE_DEBUG) {
    return
  }

  const detail =
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)

  process.stderr.write(`[periscope] ${label} failed: ${detail}\n`)
}

let internalLogger: InternalLogger = defaultInternalLogger

/**
 * Replace the internal reporter. Pass `null` to restore the default silent reporter.
 */
export function setInternalLogger(logger: InternalLogger | null): void {
  internalLogger = logger ?? defaultInternalLogger
}

/**
 * Report a swallowed failure. Never throws, never re-enters.
 */
function report(label: string, error: unknown): void {
  if (reporting) {
    return
  }

  reporting = true

  try {
    internalLogger(label, error)
  } catch {
    /* The reporter is the last line of defence: its own failures are dropped on the floor. */
  } finally {
    reporting = false
  }
}

/**
 * Run `fn`, returning its value. If it throws, the error is reported internally and `fallback`
 * is returned instead (`undefined` when no fallback is given).
 */
export function safeguard<T>(label: string, fn: () => T, fallback?: T): T | undefined {
  try {
    return fn()
  } catch (error) {
    report(label, error)
    return fallback
  }
}

/**
 * Async counterpart of {@link safeguard}. Awaits `fn`, reporting and swallowing both synchronous
 * throws and rejected promises.
 */
export async function safeguardAsync<T>(
  label: string,
  fn: () => T | Promise<T>,
  fallback?: T
): Promise<T | undefined> {
  try {
    return await fn()
  } catch (error) {
    report(label, error)
    return fallback
  }
}
