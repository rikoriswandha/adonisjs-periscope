import { ENTRY_TYPES } from '../types.ts'
import type { EntryFilters, FlushStreamEvent, LiveUpdateMode } from '../types.ts'

const entryTypeLookup: Record<string, true> = Object.fromEntries(
  ENTRY_TYPES.map((type) => [type, true] as const)
)

export function parseFlushStreamEvent(data: string): FlushStreamEvent | null {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }

  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  const indexRow = event.indexRow
  if (
    typeof event.type !== 'string' ||
    !entryTypeLookup[event.type] ||
    typeof event.uuid !== 'string' ||
    event.uuid.length === 0 ||
    !indexRow ||
    typeof indexRow !== 'object'
  ) {
    return null
  }

  const row = indexRow as Record<string, unknown>
  if (
    row.type !== event.type ||
    row.uuid !== event.uuid ||
    typeof row.batchId !== 'string' ||
    !(row.familyHash === null || typeof row.familyHash === 'string') ||
    !Array.isArray(row.tags) ||
    !row.tags.every((tag) => typeof tag === 'string') ||
    row.shouldDisplayOnIndex !== true ||
    typeof row.sequence !== 'string' ||
    typeof row.createdAt !== 'string'
  ) {
    return null
  }

  return value as FlushStreamEvent
}

export function streamEventMatchesFilters(event: FlushStreamEvent, filters: EntryFilters): boolean {
  const row = event.indexRow
  return (
    (!filters.type || filters.type === row.type) &&
    (!filters.tag || row.tags.includes(filters.tag)) &&
    (!filters.familyHash || filters.familyHash === row.familyHash) &&
    (!filters.batchId || filters.batchId === row.batchId) &&
    (filters.displayOnIndex !== true || row.shouldDisplayOnIndex)
  )
}

export function shouldPollForUpdates(mode: LiveUpdateMode, paused: boolean): boolean {
  return !paused && mode !== 'live'
}

export function liveUpdateLabel(mode: LiveUpdateMode, recordingEnabled: boolean): string {
  if (!recordingEnabled) return 'Recording offline'
  switch (mode) {
    case 'live':
      return 'Live updates'
    case 'polling':
      return 'Polling fallback'
    case 'connecting':
      return 'Connecting live'
    case 'off':
      return 'Updates paused'
  }
}
