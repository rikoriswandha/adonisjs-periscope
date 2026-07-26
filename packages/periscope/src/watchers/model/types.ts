/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * A model lifecycle mutation captured from Lucid. Application-owned values are serialised before
 * they cross this boundary, so their precise JSON-compatible shape is intentionally unknown.
 */
export type ModelEntryContent = {
  action: 'create' | 'update' | 'delete'
  model: string
  primaryKey?: string
  primaryKeyValue?: unknown
  attributes?: unknown
  dirty?: unknown
}
