/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

export type HealthCheckStatus = 'ok' | 'warning' | 'error' | 'unknown'

export type HealthCheckResult = {
  name: string
  status: HealthCheckStatus
  durationMs?: number
  message?: string
}

export type HealthCheckEntryContent = {
  status: HealthCheckStatus
  checks: HealthCheckResult[]
}
