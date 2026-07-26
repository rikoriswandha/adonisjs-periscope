/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Searchable content recorded for one outbound Undici request.
 */
export type HttpClientEntryContent = {
  method: string
  url: string
  status?: number
  durationMs: number
  requestHeaders?: Record<string, unknown>
  responseHeaders?: Record<string, unknown>
  error?: unknown
  completed: boolean
}
