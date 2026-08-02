/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

export type SocketEntryContent = Record<string, unknown> & {
  adapter: string
  socketId: string
  event: 'connected' | 'disconnected' | 'message'
  transport?: string
  channel?: string
  remoteAddress?: string
  userId?: string | number
  direction?: 'inbound' | 'outbound'
  messageEvent?: string
  sizeBytes?: number
  durationMs?: number
  reason?: string
  payload?: unknown
}
