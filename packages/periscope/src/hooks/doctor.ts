/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Implemented in Phase 7 (P7.4 — `periscopeDoctor()` hook). Phase 0 ships the module so the
 * package `exports` map resolves and `npm run build` produces every declared entry point.
 *
 * The hook is registered in an application's `adonisrc.ts` under `hooks.init`, which accepts
 * either a lazy import or an object exposing a `run` method. P7.4 fills `run` with the dev-only
 * checks: migration present for the database driver, Lucid `debug` flags versus the enabled
 * QueryWatcher, dashboard route collisions, request-watcher middleware position and Node >= 24.
 * It prints a compact table and never throws.
 */

/**
 * Shape of an assembler `hooks.init` entry. Declared structurally so the package does not need
 * a dependency on `@adonisjs/assembler` types.
 */
export type PeriscopeDoctorHook = {
  run: () => Promise<void>
}

/**
 * Creates the doctor init hook. A working no-op until P7.4.
 */
export function periscopeDoctor(): PeriscopeDoctorHook {
  return {
    run: async () => {},
  }
}
