/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Implemented in Phase 1 (P1.5 — Config + `defineConfig`). Phase 0 ships the module so the
 * package `exports` map resolves and `npm run build` produces every declared entry point.
 *
 * P1.5 replaces the identity function below with the full config shape, runtime validation
 * (negative caps, unknown storage driver) and resolved defaults, returned as an AdonisJS
 * config provider. Until then `defineConfig` only preserves the literal type of whatever
 * `config/periscope.ts` exports, which is enough for the playground to declare a config file.
 */
export function defineConfig<T extends Record<string, unknown>>(config: T): T {
  return config
}
