/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

export type DriveEntryContent = Record<string, unknown> & {
  operation: string
  key: string
  disk?: string
  durationMs: number
  destination?: string
  sizeBytes?: number
  error?: unknown
}
