/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

export type LockEntryContent = Record<string, unknown> & {
  key: string
  action: 'acquired' | 'timeout' | 'denied'
  waitedMs: number
  ttlMs?: number
}
