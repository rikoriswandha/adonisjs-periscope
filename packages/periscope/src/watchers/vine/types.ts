/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * A single VineJS validation failure.
 */
export type ValidationFieldError = Record<string, unknown> & {
  field: string
  rule: string
  message: string
  meta?: unknown
}

/**
 * The validation failures collected by one VineJS reporter.
 */
export type ValidationEntryContent = Record<string, unknown> & {
  errorCount: number
  fields: string[]
  errors: ValidationFieldError[]
}
