/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The JSON-representable result of one Bouncer authorization check.
 */
export type GateEntryContent = {
  ability: string
  allowed: boolean
  userId?: string | number
  user?: unknown
  args: unknown
  status?: number
  message?: string
}
