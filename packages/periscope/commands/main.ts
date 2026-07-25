/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { BaseCommand } from '@adonisjs/core/ace'

/**
 * Commands barrel for the `periscope/commands` subpath, referenced from an application's
 * `adonisrc.ts` under `commands`.
 *
 * Implemented in Phase 5 (P5.3 — ace commands: `periscope:prune`, `periscope:clear`,
 * `periscope:pause`). Phase 0 exports an empty list so the subpath resolves and an application
 * can register it today without a single command existing yet.
 */
const commands: (typeof BaseCommand)[] = []

export default commands
