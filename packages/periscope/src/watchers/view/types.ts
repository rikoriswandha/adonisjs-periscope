/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/** The bounded metadata retained for one Edge template render. */
export type ViewEntryContent = {
  template: string
  durationMs?: number
  dataKeys?: string[]
}
