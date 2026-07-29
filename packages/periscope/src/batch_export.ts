/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { StoredEntry } from './types.ts'
import { serializeEntry } from './http/serialize.ts'

/**
 * Serialize a stored batch into Periscope's portable, versioned export format.
 */
export function serializeBatchExport(
  batchId: string,
  entries: readonly StoredEntry[]
): string | null {
  const first = entries[0]
  if (first === undefined) {
    return null
  }

  return JSON.stringify(
    {
      format: 'periscope.batch',
      version: 1,
      batchId,
      application: first.application,
      entries: entries.map(serializeEntry),
    },
    null,
    2
  )
}
