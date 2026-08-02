/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

export type I18nEntryContent = Record<string, unknown> & {
  locale: string
  identifier: string
  hasFallback?: boolean
}
