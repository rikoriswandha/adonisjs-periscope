export type CursorPage<T> = {
  data: T[]
  nextCursor: string | null
}

export type CursorItemDecision = 'collect' | 'overlap' | 'skip'

/**
 * Walk newest-first cursor pages until the caller recognizes an overlap.
 * Reaching the backend's end cursor is the only normal alternative stopping condition.
 */
export async function walkCursorPages<T>(
  loadPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
  classify: (item: T) => CursorItemDecision
): Promise<T[]> {
  const collected: T[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  while (true) {
    const page = await loadPage(cursor)
    for (const item of page.data) {
      const decision = classify(item)
      if (decision === 'overlap') return collected
      if (decision === 'collect') collected.push(item)
    }

    if (page.nextCursor === null) return collected
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('Cursor pagination returned a repeated cursor')
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
}
