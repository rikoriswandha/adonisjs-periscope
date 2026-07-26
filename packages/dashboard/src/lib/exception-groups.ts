import type { ExceptionGroup } from '../types.ts'

export function isNewExceptionGroup(
  previous: ExceptionGroup | undefined,
  incoming: ExceptionGroup
): boolean {
  return (
    previous === undefined ||
    (previous.latest.uuid !== incoming.latest.uuid && incoming.count >= previous.count)
  )
}

export function mergeExceptionGroups(
  current: ExceptionGroup[],
  incoming: ExceptionGroup[]
): ExceptionGroup[] {
  const byFamily = new Map(current.map((group) => [group.familyHash, group]))
  for (const group of incoming) byFamily.set(group.familyHash, group)
  return [...byFamily.values()].sort(
    (left, right) => new Date(right.lastSeen).getTime() - new Date(left.lastSeen).getTime()
  )
}
