/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The package's main entry point. It re-exports the public surface that exists today; each
 * phase adds to it as watchers, storage drivers and the dashboard land.
 */

export { dump } from './dump.ts'
export { defineConfig } from './define_config.ts'
export { safeguard, safeguardAsync, setInternalLogger } from './safeguard.ts'
export type { InternalLogger } from './safeguard.ts'
export { EntryType } from './types.ts'
export type { BatchKind } from './types.ts'
