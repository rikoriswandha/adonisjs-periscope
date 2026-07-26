/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveWatcher } from './watchers/active.ts'
import { parseStack } from './watchers/exception/stack.ts'
import type { DumpCaller } from './watchers/dump/types.ts'

/**
 * Record values for an open dashboard dump view and return the first value unchanged.
 *
 * Looking up the watcher and its cached flag is entirely synchronous. Stack capture and value
 * serialisation happen only while the dashboard is listening, keeping an inactive `dump()` to a
 * module-slot lookup and two branches. Every diagnostic operation is best-effort: application
 * control flow must never change because Periscope could not inspect or record a value.
 */
export function dump<T>(first: T, ...rest: unknown[]): T {
  try {
    const watcher = getActiveWatcher('dump')

    if (watcher !== null && watcher.active) {
      let caller: DumpCaller | undefined
      const stack = new Error().stack

      if (typeof stack === 'string') {
        const frames = parseStack(stack)

        for (const frame of frames) {
          const functionName = frame.function ?? ''

          if (functionName === 'dump' || functionName.endsWith('.dump')) {
            continue
          }

          if (frame.type !== 'native' && frame.line !== null) {
            caller = {
              file: frame.file,
              line: frame.line,
              ...(frame.column === null ? {} : { column: frame.column }),
            }
            break
          }
        }
      }

      watcher.record([first, ...rest], caller)
    }
  } catch {
    /** Diagnostics are never allowed to throw into the host application. */
  }

  return first
}
