import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useDashboard } from '@/dashboard-context'
import { walkCursorPages } from '@/hooks/walk-cursor-pages'
import { api } from '@/lib/api'
import { shouldPollForUpdates, streamEventMatchesFilters } from '@/lib/live-updates'
import type { EntryFilters, StoredEntry } from '@/types'

export function usePolling(
  callback: () => void | Promise<void>,
  options: { enabled: boolean; immediate?: boolean; interval?: number }
) {
  const callbackRef = useRef(callback)
  const inFlightRef = useRef<Promise<void> | null>(null)
  callbackRef.current = callback

  useEffect(() => {
    if (!options.enabled) return

    const run = () => {
      if (document.visibilityState !== 'visible' || inFlightRef.current) return
      const request: Promise<void> = Promise.resolve()
        .then(() => callbackRef.current())
        .catch(() => undefined)
        .then(() => undefined)
        .finally(() => {
          if (inFlightRef.current === request) inFlightRef.current = null
        })
      inFlightRef.current = request
    }

    if (options.immediate) run()
    const interval = window.setInterval(run, options.interval ?? 2_500)
    document.addEventListener('visibilitychange', run)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', run)
    }
  }, [options.enabled, options.immediate, options.interval])
}

export function useNewEntryPolling(
  entries: StoredEntry[],
  filters: EntryFilters,
  paused: boolean,
  revision: number
) {
  const { liveUpdateMode, flushEvent, flushRevision, selectedApplication } = useDashboard()
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const [pending, setPending] = useState<StoredEntry[]>([])
  const pendingRef = useRef<StoredEntry[]>([])
  const pendingGenerationRef = useRef(0)
  const generationRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const filterKey = useMemo(
    () => JSON.stringify({ ...filters, application: selectedApplication }),
    [filters, selectedApplication]
  )
  const stableFilters = useMemo<EntryFilters>(
    () => JSON.parse(filterKey) as EntryFilters,
    [filterKey]
  )
  const scopeKey = `${revision}:${filterKey}`
  const scopeKeyRef = useRef(scopeKey)

  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey
    generationRef.current += 1
    controllerRef.current?.abort()
    pendingRef.current = []
    pendingGenerationRef.current = -1
  }

  useEffect(() => {
    pendingRef.current = []
    pendingGenerationRef.current = generationRef.current
    setPending([])
  }, [scopeKey])

  useEffect(
    () => () => {
      generationRef.current += 1
      controllerRef.current?.abort()
    },
    []
  )

  const scanForNewEntries = useCallback(async () => {
    const generation = generationRef.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const known = new Set(entriesRef.current.map((entry) => entry.uuid))
    for (const entry of pendingRef.current) known.add(entry.uuid)
    const collected = new Set<string>()

    try {
      const fresh = await walkCursorPages(
        (cursor) =>
          api.listEntries(
            {
              ...stableFilters,
              cursor,
              displayOnIndex: true,
              limit: 100,
            },
            controller.signal
          ),
        (entry) => {
          if (known.has(entry.uuid)) return 'overlap'
          if (collected.has(entry.uuid)) return 'skip'
          collected.add(entry.uuid)
          return 'collect'
        }
      )
      if (controller.signal.aborted || generation !== generationRef.current) return

      const currentKnown = new Set(entriesRef.current.map((entry) => entry.uuid))
      for (const entry of pendingRef.current) currentKnown.add(entry.uuid)
      const additions = fresh.filter((entry) => !currentKnown.has(entry.uuid))
      if (additions.length === 0) return

      const next = [...additions, ...pendingRef.current]
      pendingRef.current = next
      pendingGenerationRef.current = generation
      setPending(next)
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [stableFilters])

  useEffect(() => {
    if (
      paused ||
      liveUpdateMode !== 'live' ||
      !flushEvent ||
      !streamEventMatchesFilters(flushEvent, stableFilters)
    ) {
      return
    }
    void scanForNewEntries().catch(() => undefined)
  }, [flushEvent, flushRevision, liveUpdateMode, paused, scanForNewEntries, stableFilters])

  usePolling(scanForNewEntries, {
    enabled: shouldPollForUpdates(liveUpdateMode, paused),
    immediate: true,
  })

  const accept = useCallback(() => {
    if (pendingGenerationRef.current !== generationRef.current) return []
    const accepted = pendingRef.current
    pendingRef.current = []
    setPending([])
    return accepted
  }, [])

  return {
    pending: pendingGenerationRef.current === generationRef.current ? pending : [],
    accept,
  }
}
