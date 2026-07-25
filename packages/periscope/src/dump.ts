/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Implemented in Phase 6 (P6.6 — DumpWatcher). Phase 0 ships the module so the package
 * `exports` map resolves and `npm run build` produces every declared entry point.
 *
 * The pass-through behaviour below is the final, specified behaviour: `dump()` returns its
 * first argument so it can be wrapped around an expression inline
 * (`const user = dump(await User.find(1))`). P6.6 adds the recording side — `safeSerialize`,
 * caller `file:line` from the stack, and the `dump-open` flag gate — without changing what
 * the function returns.
 */
export function dump<T>(...values: T[]): T {
  return values[0]
}
