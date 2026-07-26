import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from '@/lib/api'
import type { EntryFilters, StoredEntry } from '@/types'

function mergeUnique(
  current: StoredEntry[],
  incoming: StoredEntry[],
  position: 'start' | 'end'
): StoredEntry[] {
  const seen = new Set<string>()
  const ordered = position === 'start' ? [...incoming, ...current] : [...current, ...incoming]
  return ordered.filter((entry) => {
    if (seen.has(entry.uuid)) return false
    seen.add(entry.uuid)
    return true
  })
}

export function useCursorPagination(filters: EntryFilters) {
  const filterKey = useMemo(() => JSON.stringify(filters), [filters])
  const stableFilters = useMemo<EntryFilters>(
    () => JSON.parse(filterKey) as EntryFilters,
    [filterKey]
  )
  const [entries, setEntries] = useState<StoredEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const requestGeneration = useRef(0)
  const loadingMoreRef = useRef(false)

  const loadInitial = useCallback(async () => {
    const generation = ++requestGeneration.current
    loadingMoreRef.current = false
    setLoadingMore(false)
    setLoading(true)
    setError(null)
    try {
      const page = await api.listEntries(stableFilters)
      if (generation !== requestGeneration.current) return
      setEntries(page.data)
      setNextCursor(page.nextCursor)
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof Error ? cause : new Error('Unable to load entries'))
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }, [stableFilters])

  useEffect(() => {
    setEntries([])
    setNextCursor(null)
    void loadInitial()
    return () => {
      requestGeneration.current += 1
    }
  }, [loadInitial])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMoreRef.current) return
    const generation = requestGeneration.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    setError(null)
    try {
      const page = await api.listEntries({
        ...stableFilters,
        cursor: nextCursor,
      })
      if (generation !== requestGeneration.current) return
      setEntries((current) => mergeUnique(current, page.data, 'end'))
      setNextCursor(page.nextCursor)
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(cause instanceof Error ? cause : new Error('Unable to load more entries'))
    } finally {
      if (generation === requestGeneration.current) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }, [nextCursor, stableFilters])

  const prepend = useCallback((incoming: StoredEntry[]) => {
    setEntries((current) => mergeUnique(current, incoming, 'start'))
  }, [])

  return {
    entries,
    error,
    hasMore: nextCursor !== null,
    loading,
    loadingMore,
    loadMore,
    prepend,
    reload: loadInitial,
  }
}
