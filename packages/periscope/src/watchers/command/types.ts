/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Content recorded for one Ace command execution.
 */
export type CommandEntryContent = {
  command: string
  args: unknown
  flags: unknown
  isMain: boolean
  exitCode: number
  durationMs: number
  /**
   * Bounded, redacted text rendered through the command's Ace UI.
   */
  output?: string
  error?: unknown
}
