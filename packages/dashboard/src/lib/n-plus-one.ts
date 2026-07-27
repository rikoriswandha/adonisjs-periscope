import type { StoredEntry } from '@/types'

export type NPlusOneWarning = {
  familyHash: string
  count: number
  sql: string | null
}

/** Group repeated query shapes inside one batch; null family hashes cannot identify a shape. */
export function detectNPlusOneWarnings(
  entries: readonly StoredEntry[],
  threshold: number
): NPlusOneWarning[] {
  const groups = new Map<string, NPlusOneWarning>()

  for (const entry of entries) {
    if (entry.type !== 'query' || entry.familyHash === null) continue
    const current = groups.get(entry.familyHash)
    if (current) {
      current.count += 1
      continue
    }

    groups.set(entry.familyHash, {
      familyHash: entry.familyHash,
      count: 1,
      sql: typeof entry.content.sql === 'string' ? entry.content.sql : null,
    })
  }

  return [...groups.values()]
    .filter((group) => group.count >= Math.max(1, threshold))
    .sort(
      (left, right) => right.count - left.count || left.familyHash.localeCompare(right.familyHash)
    )
}
