/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { ExceptionGroup, ExceptionGroupState, Paginated, StoredEntry } from '../types.ts'

export type StoredEntryTransport = Omit<StoredEntry, 'sequence' | 'createdAt'> & {
  sequence: string
  createdAt: string
}

export type ExceptionGroupTransport = {
  familyHash: string
  latest: StoredEntryTransport
  count: number
  lastSeen: string
  state: ExceptionGroupState
  stateUpdatedAt: string | null
}

/**
 * Convert the two non-JSON primitives at the storage boundary without walking or copying the
 * already-safe entry content.
 */
export function serializeEntry(entry: StoredEntry): StoredEntryTransport {
  return {
    uuid: entry.uuid,
    batchId: entry.batchId,
    application: entry.application,
    type: entry.type,
    familyHash: entry.familyHash,
    content: entry.content,
    tags: entry.tags,
    shouldDisplayOnIndex: entry.shouldDisplayOnIndex,
    sequence: entry.sequence.toString(),
    createdAt: entry.createdAt.toISOString(),
  }
}

export function serializeEntryPage(page: Paginated<StoredEntry>): Paginated<StoredEntryTransport> {
  return {
    data: page.data.map(serializeEntry),
    nextCursor: page.nextCursor,
  }
}

export function serializeExceptionGroupPage(
  page: Paginated<ExceptionGroup>,
  states: ReadonlyMap<string, { state: ExceptionGroupState; stateUpdatedAt: string | null }>
): Paginated<ExceptionGroupTransport> {
  return {
    data: page.data.map((group) => ({
      familyHash: group.familyHash,
      latest: serializeEntry(group.latest),
      count: group.count,
      lastSeen: group.lastSeen.toISOString(),
      ...(states.get(group.familyHash) ?? { state: 'open', stateUpdatedAt: null }),
    })),
    nextCursor: page.nextCursor,
  }
}
