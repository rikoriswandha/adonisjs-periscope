/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { EntryType } from '../types.ts'
import type { ExceptionGroup, ExceptionGroupQuery, Paginated, StoredEntry } from '../types.ts'
import { encodeCursor, parseCursor, resolvePageSize } from './pagination.ts'

/**
 * Group exception occurrences in memory after a driver has selected exception rows. Keeping this
 * deliberately small and shared makes the three drivers agree on family pagination without
 * relying on dialect-specific window functions.
 */
export function aggregateExceptionGroups(
  entries: Iterable<StoredEntry>,
  query: ExceptionGroupQuery = {}
): Paginated<ExceptionGroup> {
  const grouped = new Map<string, ExceptionGroup>()

  for (const entry of entries) {
    if (entry.type !== EntryType.EXCEPTION || entry.familyHash === null) {
      continue
    }

    const existing = grouped.get(entry.familyHash)

    if (existing === undefined) {
      grouped.set(entry.familyHash, {
        familyHash: entry.familyHash,
        latest: entry,
        count: 1,
        lastSeen: new Date(entry.createdAt.getTime()),
      })
      continue
    }

    existing.count += 1

    if (entry.sequence > existing.latest.sequence) {
      existing.latest = entry
      existing.lastSeen = new Date(entry.createdAt.getTime())
    }
  }

  const cursor = parseCursor(query.cursor)
  const groups = [...grouped.values()]
    .filter((group) => cursor === null || group.latest.sequence < cursor)
    .sort((left, right) => {
      if (left.latest.sequence === right.latest.sequence) {
        return 0
      }

      return left.latest.sequence > right.latest.sequence ? -1 : 1
    })
  const limit = resolvePageSize(query.limit)
  const page = groups.slice(0, limit)

  return {
    data: page,
    nextCursor: groups.length > limit ? encodeCursor(page[page.length - 1].latest.sequence) : null,
  }
}
