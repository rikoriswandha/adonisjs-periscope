/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

export type NotificationEntryContent = Record<string, unknown> & {
  adapter: string
  channel: string
  notification: string
  status: 'sent' | 'failed'
  notifiable?: string | number
  durationMs?: number
  payload?: unknown
  error?: unknown
}
