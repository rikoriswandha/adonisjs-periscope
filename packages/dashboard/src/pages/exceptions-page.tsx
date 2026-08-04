import {
  ArrowDown,
  ArrowUpRight,
  Check,
  CircleAlert,
  EyeOff,
  Inbox,
  RefreshCw,
  RotateCcw,
  Route,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { EntryDetailDrawer, EntryDetailScope } from '@/components/entry-detail-drawer'
import { JsonTree } from '@/components/json-tree'
import { PageHeader } from '@/components/page-header'
import { StackTrace } from '@/components/stack-trace'
import { StatusBadge } from '@/components/status-badge'
import { TagChip } from '@/components/tag-chip'
import { Panel, PanelBody, PanelHeader, SignalMeter, StatusDot } from '@/components/instrument'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { RegisteredEntryDetailProps } from '@/entry-type-registry'
import { useDashboard } from '@/dashboard-context'
import { usePolling } from '@/hooks/use-polling'
import { walkCursorPages } from '@/hooks/walk-cursor-pages'
import { api } from '@/lib/api'
import { isNewExceptionGroup, mergeExceptionGroups } from '@/lib/exception-groups'
import { bucketExceptionOccurrences } from '@/lib/exception-trend'
import { shouldPollForUpdates } from '@/lib/live-updates'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { ExceptionContent, ExceptionGroup, ExceptionGroupState, StoredEntry } from '@/types'

function exceptionContent(entry: StoredEntry): ExceptionContent {
  return entry.content as ExceptionContent
}
const TREND_WINDOW_MS = 24 * 60 * 60 * 1000

type ExceptionStateFilter = 'all' | ExceptionGroupState

const exceptionStateFilters: ReadonlyArray<{ label: string; value: ExceptionStateFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Open', value: 'open' },
  { label: 'Resolved', value: 'resolved' },
  { label: 'Ignored', value: 'ignored' },
]

function ExceptionTrend({ buckets }: { buckets: number[] }) {
  const width = 88
  const height = 24
  const max = Math.max(1, ...buckets)
  const points = buckets
    .map((count, index) => {
      const x = buckets.length === 1 ? width / 2 : (index / (buckets.length - 1)) * width
      const y = height - 2 - (count / max) * (height - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const occurrenceCount = buckets.reduce((total, count) => total + count, 0)

  return (
    <svg
      aria-label={`${occurrenceCount.toLocaleString()} occurrences in the last 24 hours`}
      className="h-6 w-[5.5rem] text-sig-error"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      <polyline
        fill="none"
        points={points}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function ExceptionStateBadge({ state }: { state: ExceptionGroupState }) {
  const signal = state === 'open' ? 'error' : state === 'resolved' ? 'ok' : 'neutral'

  return (
    <span className="inline-flex items-center gap-2 text-xs text-ink-2 capitalize">
      <StatusDot signal={signal} />
      {state}
    </span>
  )
}

function ExceptionOccurrenceContent({ entry }: { entry: StoredEntry }) {
  const content = exceptionContent(entry)

  return (
    <>
      {content.request && (
        <section className="well min-w-0 p-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <Route aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
            <span className="num shrink-0">{content.request.method}</span>
            <span className="num min-w-0 truncate" title={content.request.url}>
              {content.request.url}
            </span>
          </div>
          {content.request.route && (
            <p
              className="num mt-1 min-w-0 truncate text-xs text-ink-3"
              title={`${content.request.route.pattern}${content.request.route.name ? ` · ${content.request.route.name}` : ''}`}
            >
              {content.request.route.pattern}
              {content.request.route.name ? ` · ${content.request.route.name}` : ''}
            </p>
          )}
        </section>
      )}

      <StackTrace
        codeFrame={content.codeFrame}
        fallback={content.stack}
        frames={content.frames ?? []}
      />

      {content.context !== undefined && (
        <JsonTree label="Exception context" value={content.context} />
      )}

      <dl className="grid min-w-0 gap-2.5 rounded-md border p-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Family hash</dt>
          <dd className="num mt-0.5 truncate text-xs" title={entry.familyHash ?? undefined}>
            {entry.familyHash ?? 'Unavailable'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Sequence</dt>
          <dd className="num mt-0.5 truncate text-xs">{entry.sequence}</dd>
        </div>
      </dl>

      <Button
        render={<Link to={`/requests/${encodeURIComponent(entry.batchId)}`} />}
        variant="outline"
      >
        <ArrowUpRight aria-hidden="true" />
        Open request batch
      </Button>
    </>
  )
}

export function ExceptionEntryDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = exceptionContent(entry)
  return (
    <EntryDetailDrawer
      description={formatDateTime(entry.createdAt)}
      meta={
        <>
          <StatusBadge status={content.status} />
          {content.code && <Badge variant="secondary">{content.code}</Badge>}
        </>
      }
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      open={open}
      tags={entry.tags}
      title={`${content.name}: ${truncate(content.message, 100)}`}
    >
      <ExceptionOccurrenceContent entry={entry} />
    </EntryDetailDrawer>
  )
}

export function ExceptionsPage() {
  const [searchParams] = useSearchParams()
  const { status, revision, liveUpdateMode, flushEvent, flushRevision, selectedApplication } =
    useDashboard()
  const tag = searchParams.get('tag')?.trim() || undefined
  const familyHash = searchParams.get('familyHash')?.trim() || undefined
  const [groups, setGroups] = useState<ExceptionGroup[]>([])
  const [pendingGroups, setPendingGroups] = useState<ExceptionGroup[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [selectedGroup, setSelectedGroup] = useState<ExceptionGroup | null>(null)
  const [occurrences, setOccurrences] = useState<StoredEntry[]>([])
  const [selectedOccurrence, setSelectedOccurrence] = useState<StoredEntry | null>(null)
  const [occurrencesLoading, setOccurrencesLoading] = useState(false)
  const [occurrencesError, setOccurrencesError] = useState<Error | null>(null)
  const [occurrencesNextCursor, setOccurrencesNextCursor] = useState<string | null>(null)
  const [occurrencesLoadingMore, setOccurrencesLoadingMore] = useState(false)
  const [stateFilter, setStateFilter] = useState<ExceptionStateFilter>('open')
  const [triagePending, setTriagePending] = useState<Set<string>>(() => new Set())
  const [triageError, setTriageError] = useState<Error | null>(null)
  const [trendBucketsByFamily, setTrendBucketsByFamily] = useState<Record<string, number[]>>({})
  const groupsRef = useRef(groups)
  const pendingGroupsRef = useRef(pendingGroups)
  const requestGenerationRef = useRef(0)
  const pollingGenerationRef = useRef(0)
  const listControllerRef = useRef<AbortController | null>(null)
  const pollingControllerRef = useRef<AbortController | null>(null)
  const deepLinkPagingRef = useRef(false)
  const handledFamilyHashRef = useRef<string | null>(null)
  const scopeKey = `${revision}:${selectedApplication}:${tag ?? ''}`
  const scopeKeyRef = useRef(scopeKey)
  const scopeChanged = scopeKeyRef.current !== scopeKey
  groupsRef.current = groups
  pendingGroupsRef.current = pendingGroups

  if (scopeChanged) {
    scopeKeyRef.current = scopeKey
    requestGenerationRef.current += 1
    pollingGenerationRef.current += 1
    listControllerRef.current?.abort()
    pollingControllerRef.current?.abort()
    groupsRef.current = []
    pendingGroupsRef.current = []
    handledFamilyHashRef.current = null
  }

  const loadInitial = useCallback(async () => {
    pollingGenerationRef.current += 1
    pollingControllerRef.current?.abort()
    listControllerRef.current?.abort()
    const controller = new AbortController()
    const generation = ++requestGenerationRef.current
    listControllerRef.current = controller
    setLoadingMore(false)
    setLoading(true)
    setError(null)
    try {
      const page = await api.getExceptionGroups(
        { limit: 50, tag, application: selectedApplication },
        controller.signal
      )
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return
      groupsRef.current = page.data
      pendingGroupsRef.current = []
      setGroups(page.data)
      setNextCursor(page.nextCursor)
      setPendingGroups([])
    } catch (cause) {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return
      setError(cause instanceof Error ? cause : new Error('Unable to load exception groups'))
    } finally {
      if (generation === requestGenerationRef.current) {
        if (listControllerRef.current === controller) listControllerRef.current = null
        setLoading(false)
      }
    }
  }, [selectedApplication, tag])

  useEffect(() => {
    groupsRef.current = []
    pendingGroupsRef.current = []
    setGroups([])
    setPendingGroups([])
    setNextCursor(null)
    setSelectedGroup(null)
    setTriageError(null)
    setTrendBucketsByFamily({})
    void loadInitial()
    return () => {
      requestGenerationRef.current += 1
      pollingGenerationRef.current += 1
      listControllerRef.current?.abort()
      pollingControllerRef.current?.abort()
    }
  }, [loadInitial, revision])

  const scanForNewGroups = useCallback(async () => {
    const generation = pollingGenerationRef.current
    pollingControllerRef.current?.abort()
    const controller = new AbortController()
    pollingControllerRef.current = controller
    const known = new Map(
      [...groupsRef.current, ...pendingGroupsRef.current].map((group) => [group.familyHash, group])
    )

    try {
      const fresh = await walkCursorPages(
        (cursor) =>
          api.getExceptionGroups(
            { cursor, limit: 50, tag, application: selectedApplication },
            controller.signal
          ),
        (group) => {
          const previous = known.get(group.familyHash)
          if (!previous) {
            known.set(group.familyHash, group)
            return 'collect'
          }
          if (!isNewExceptionGroup(previous, group)) return 'overlap'
          known.set(group.familyHash, group)
          return 'collect'
        }
      )
      if (controller.signal.aborted || generation !== pollingGenerationRef.current) return

      const current = new Map(
        [...groupsRef.current, ...pendingGroupsRef.current].map((group) => [
          group.familyHash,
          group,
        ])
      )
      const additions = fresh.filter((group) => {
        const previous = current.get(group.familyHash)
        return isNewExceptionGroup(previous, group)
      })
      if (additions.length === 0) return

      const next = mergeExceptionGroups(pendingGroupsRef.current, additions)
      pendingGroupsRef.current = next
      setPendingGroups(next)
    } finally {
      if (pollingControllerRef.current === controller) pollingControllerRef.current = null
    }
  }, [selectedApplication, tag])

  useEffect(() => {
    if (
      loading ||
      status?.paused !== false ||
      liveUpdateMode !== 'live' ||
      flushEvent?.type !== 'exception' ||
      (tag && !flushEvent.indexRow.tags.includes(tag))
    ) {
      return
    }
    void scanForNewGroups().catch(() => undefined)
  }, [flushEvent, flushRevision, liveUpdateMode, loading, scanForNewGroups, status?.paused, tag])

  usePolling(scanForNewGroups, {
    enabled: !loading && shouldPollForUpdates(liveUpdateMode, status?.paused ?? true),
    immediate: true,
  })
  useEffect(() => {
    if (!selectedGroup) {
      setOccurrences([])
      setSelectedOccurrence(null)
      setOccurrencesError(null)
      setOccurrencesNextCursor(null)
      return
    }
    const controller = new AbortController()
    setOccurrencesLoading(true)
    setOccurrencesError(null)
    api
      .listEntries(
        {
          type: 'exception',
          familyHash: selectedGroup.familyHash,
          application: selectedApplication,
          limit: 50,
        },
        controller.signal
      )
      .then((page) => {
        const loaded = page.data.length > 0 ? page.data : [selectedGroup.latest]
        setOccurrences(loaded)
        setSelectedOccurrence(loaded[0] ?? selectedGroup.latest)
        setOccurrencesNextCursor(page.nextCursor)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setOccurrencesError(
            cause instanceof Error ? cause : new Error('Unable to load exception occurrences')
          )
          setSelectedOccurrence(selectedGroup.latest)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setOccurrencesLoading(false)
      })
    return () => controller.abort()
  }, [selectedApplication, selectedGroup])
  /**
   * Opening a family is the lazy-load boundary: trends become available row by row without
   * turning the initial exception index into one request per family.
   */
  useEffect(() => {
    if (!selectedGroup || trendBucketsByFamily[selectedGroup.familyHash]) return

    const controller = new AbortController()
    const now = Date.now()
    api
      .listEntries(
        {
          type: 'exception',
          familyHash: selectedGroup.familyHash,
          application: selectedApplication,
          from: new Date(now - TREND_WINDOW_MS).toISOString(),
          limit: 200,
        },
        controller.signal
      )
      .then((page) => {
        if (controller.signal.aborted) return
        setTrendBucketsByFamily((currentBuckets) => ({
          ...currentBuckets,
          [selectedGroup.familyHash]: bucketExceptionOccurrences(page.data, now),
        }))
      })
      .catch(() => {
        // Trend context is supplementary; occurrence details remain available when it cannot load.
      })

    return () => controller.abort()
  }, [selectedApplication, selectedGroup, trendBucketsByFamily])

  const visibleGroups = scopeChanged ? [] : groups
  const visiblePendingGroups = scopeChanged ? [] : pendingGroups
  const filteredGroups =
    stateFilter === 'all'
      ? visibleGroups
      : visibleGroups.filter((group) => group.state === stateFilter)
  const maxOccurrenceCount = Math.max(0, ...filteredGroups.map((group) => group.count))
  const pendingNewCount = visiblePendingGroups.reduce((total, group) => {
    const current = visibleGroups.find((candidate) => candidate.familyHash === group.familyHash)
    return total + Math.max(1, group.count - (current?.count ?? 0))
  }, 0)

  const loadMore = useCallback(async () => {
    if (!nextCursor || listControllerRef.current) return
    const controller = new AbortController()
    const generation = requestGenerationRef.current
    listControllerRef.current = controller
    setLoadingMore(true)
    setError(null)
    try {
      const page = await api.getExceptionGroups(
        { cursor: nextCursor, limit: 50, tag, application: selectedApplication },
        controller.signal
      )
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return
      const next = mergeExceptionGroups(groupsRef.current, page.data)
      groupsRef.current = next
      setGroups(next)
      setNextCursor(page.nextCursor)
    } catch (cause) {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return
      setError(cause instanceof Error ? cause : new Error('Unable to load older groups'))
    } finally {
      if (generation === requestGenerationRef.current) {
        if (listControllerRef.current === controller) listControllerRef.current = null
        setLoadingMore(false)
      }
    }
  }, [nextCursor, selectedApplication, tag])
  const loadMoreOccurrences = async () => {
    if (!selectedGroup || !occurrencesNextCursor || occurrencesLoadingMore) return
    setOccurrencesLoadingMore(true)
    setOccurrencesError(null)
    try {
      const page = await api.listEntries({
        type: 'exception',
        familyHash: selectedGroup.familyHash,
        cursor: occurrencesNextCursor,
        application: selectedApplication,
        limit: 50,
      })
      setOccurrences((currentEntries) => {
        const known = new Set(currentEntries.map((entry) => entry.uuid))
        return [...currentEntries, ...page.data.filter((entry) => !known.has(entry.uuid))]
      })
      setOccurrencesNextCursor(page.nextCursor)
    } catch (cause) {
      setOccurrencesError(
        cause instanceof Error ? cause : new Error('Unable to load older occurrences')
      )
    } finally {
      setOccurrencesLoadingMore(false)
    }
  }

  const setGroupState = async (group: ExceptionGroup, state: ExceptionGroupState) => {
    if (group.state === state || triagePending.has(group.familyHash)) return

    const previous = {
      state: group.state,
      stateUpdatedAt: group.stateUpdatedAt,
    }
    const applyState = (items: ExceptionGroup[], next: typeof previous) =>
      items.map((candidate) =>
        candidate.familyHash === group.familyHash ? { ...candidate, ...next } : candidate
      )
    const optimistic = {
      state,
      stateUpdatedAt: state === 'open' ? null : new Date().toISOString(),
    }

    groupsRef.current = applyState(groupsRef.current, optimistic)
    setGroups(groupsRef.current)
    setTriageError(null)
    setTriagePending((currentPending) => new Set(currentPending).add(group.familyHash))

    try {
      const result = await api.setExceptionGroupState(group.familyHash, state, selectedApplication)
      groupsRef.current = applyState(groupsRef.current, {
        state: result.state,
        stateUpdatedAt: result.stateUpdatedAt,
      })
      setGroups(groupsRef.current)
    } catch (cause) {
      groupsRef.current = applyState(groupsRef.current, previous)
      setGroups(groupsRef.current)
      setTriageError(
        cause instanceof Error ? cause : new Error(`Unable to mark exception as ${state}`)
      )
    } finally {
      setTriagePending((currentPending) => {
        const nextPending = new Set(currentPending)
        nextPending.delete(group.familyHash)
        return nextPending
      })
    }
  }

  const acceptPending = () => {
    const accepted = pendingGroupsRef.current
    if (accepted.length === 0) return
    const next = mergeExceptionGroups(groupsRef.current, accepted)
    groupsRef.current = next
    pendingGroupsRef.current = []
    setGroups(next)
    setPendingGroups([])
  }

  const indexLoading = loading || scopeChanged
  const current = selectedOccurrence ? exceptionContent(selectedOccurrence) : null
  const openGroup = useCallback((group: ExceptionGroup) => {
    setSelectedOccurrence(group.latest)
    setSelectedGroup(group)
  }, [])

  useEffect(() => {
    if (!familyHash) {
      handledFamilyHashRef.current = null
      return
    }
    if (indexLoading || handledFamilyHashRef.current === familyHash) return

    const group = groups.find((candidate) => candidate.familyHash === familyHash)
    if (!group) {
      if (nextCursor && !loadingMore && !error && !deepLinkPagingRef.current) {
        deepLinkPagingRef.current = true
        void loadMore().finally(() => {
          deepLinkPagingRef.current = false
        })
      }
      return
    }

    handledFamilyHashRef.current = familyHash
    setStateFilter('all')
    openGroup(group)
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`exception-family-${encodeURIComponent(familyHash)}`)
        ?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [error, familyHash, groups, indexLoading, loadMore, loadingMore, nextCursor, openGroup])

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Exception families"
        description="Recurring failures are grouped by stack signature so frequency and the latest occurrence stay visible together."
        aside={
          tag && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Route aria-hidden="true" className="size-3.5" />
              <TagChip tag={tag} />
            </span>
          )
        }
      />

      {pendingNewCount > 0 && (
        <div className="flex justify-center">
          <Button
            className="font-mono text-xs tabular-nums"
            onClick={acceptPending}
            size="sm"
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" />
            {pendingNewCount} new {pendingNewCount === 1 ? 'exception' : 'exceptions'}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink-3">Triage</span>
        <ToggleGroup
          aria-label="Filter exception families by triage state"
          onValueChange={(value) => {
            const next = value[0] as ExceptionStateFilter | undefined
            if (next) setStateFilter(next)
          }}
          value={[stateFilter]}
          variant="outline"
        >
          {exceptionStateFilters.map((filter) => (
            <ToggleGroupItem
              className="h-[var(--control-h)] px-2.5 text-xs"
              key={filter.value}
              value={filter.value}
            >
              {filter.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <Panel className="overflow-hidden">
        <PanelHeader
          meta={`${filteredGroups.length.toLocaleString()} shown`}
          title="Exception groups"
        />
        <PanelBody className="p-0">
          <div className="overflow-x-auto">
            <Table className="min-w-data-table text-xs max-sm:min-w-0">
              <TableCaption className="sr-only">Grouped recorded exceptions</TableCaption>
              <TableHeader className="max-sm:hidden">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="micro-label w-32 text-right" scope="col">
                    Occurrences
                  </TableHead>
                  <TableHead className="micro-label" scope="col">
                    Exception
                  </TableHead>
                  <TableHead className="micro-label w-36" scope="col">
                    Last seen
                  </TableHead>
                  <TableHead className="micro-label w-24" scope="col">
                    State
                  </TableHead>
                  <TableHead className="micro-label w-32" scope="col">
                    24h trend
                  </TableHead>
                  <TableHead className="micro-label w-28" scope="col">
                    Actions
                  </TableHead>
                  <TableHead className="w-10" scope="col">
                    <span className="sr-only">Open details</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {indexLoading &&
                  Array.from({ length: 7 }, (_, index) => (
                    <TableRow
                      className="max-sm:flex max-sm:h-auto max-sm:flex-wrap max-sm:items-center max-sm:py-1"
                      key={index}
                    >
                      <TableCell className="w-32 px-2.5 py-2 max-sm:order-4 max-sm:h-auto max-sm:w-auto max-sm:py-0">
                        <Skeleton className="h-5 w-14" />
                      </TableCell>
                      <TableCell className="max-w-0 px-2.5 py-2 max-sm:order-1 max-sm:h-auto max-sm:w-0 max-sm:max-w-none max-sm:flex-1 max-sm:py-1 max-sm:pr-1">
                        <div className="space-y-1">
                          <Skeleton className="h-3 w-32 max-w-full" />
                          <Skeleton className="h-4 w-full max-w-xl" />
                        </div>
                      </TableCell>
                      <TableCell className="px-2.5 py-2 max-sm:order-5 max-sm:h-auto max-sm:py-0">
                        <Skeleton className="h-5 w-14" />
                      </TableCell>
                      <TableCell className="px-2.5 py-2 max-sm:order-2 max-sm:ms-auto max-sm:h-auto max-sm:py-1 max-sm:pl-1">
                        <Skeleton className="h-5 w-14" />
                      </TableCell>
                      <TableCell
                        aria-hidden="true"
                        className="hidden max-sm:order-3 max-sm:block max-sm:h-0 max-sm:w-full max-sm:p-0"
                      />
                      <TableCell className="px-2.5 py-2 max-sm:hidden">
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                      <TableCell className="px-2.5 py-2 max-sm:order-6 max-sm:ms-auto max-sm:h-auto max-sm:py-0">
                        <Skeleton className="h-7 w-24" />
                      </TableCell>
                      <TableCell className="px-2.5 py-2 max-sm:hidden" />
                    </TableRow>
                  ))}
                {!indexLoading &&
                  filteredGroups.map((group) => {
                    const content = exceptionContent(group.latest)
                    return (
                      <TableRow
                        aria-selected={familyHash === group.familyHash}
                        className={`cursor-pointer transition-colors duration-(--dur-fast) hover:bg-panel-raised max-sm:flex max-sm:h-auto max-sm:flex-wrap max-sm:items-center max-sm:py-1 ${
                          familyHash === group.familyHash
                            ? 'bg-sig-error/10 outline outline-1 -outline-offset-1 outline-sig-error/60'
                            : ''
                        }`}
                        id={`exception-family-${encodeURIComponent(group.familyHash)}`}
                        key={group.familyHash}
                        onClick={() => openGroup(group)}
                      >
                        <TableCell className="w-32 py-[var(--cell-py)] text-right max-sm:order-4 max-sm:h-auto max-sm:w-auto max-sm:py-0 max-sm:pl-2.5 max-sm:pr-1 max-sm:text-left max-sm:text-micro max-sm:text-ink-3">
                          <div className="ms-auto w-24 space-y-1 max-sm:ms-0 max-sm:w-auto max-sm:space-y-0">
                            <span className="num block text-sm font-semibold text-ink max-sm:text-micro max-sm:font-normal max-sm:text-ink-3">
                              {group.count.toLocaleString()}
                            </span>
                            <SignalMeter
                              className="ms-auto max-sm:hidden"
                              max={maxOccurrenceCount}
                              signal="error"
                              value={group.count}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="max-w-0 py-[var(--cell-py)] max-sm:order-1 max-sm:h-auto max-sm:w-0 max-sm:max-w-none max-sm:flex-1 max-sm:py-1 max-sm:pr-1">
                          <button
                            className="block w-full min-w-0 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                            type="button"
                          >
                            <span className="sr-only">
                              Inspect {content.name}: {content.message}.{' '}
                            </span>
                            <span className="block min-w-0">
                              <span className="num block truncate text-xs font-medium text-ink">
                                {content.name}
                                {content.code ? ` · ${content.code}` : ''}
                              </span>
                              <span
                                className="mt-1 block truncate text-sm text-ink-2"
                                title={content.message}
                              >
                                {content.message}
                              </span>
                            </span>
                          </button>
                        </TableCell>
                        <TableCell className="num whitespace-nowrap py-[var(--cell-py)] text-xs text-ink-3 max-sm:order-5 max-sm:h-auto max-sm:py-0 max-sm:pr-1 max-sm:text-micro">
                          <span aria-hidden="true" className="hidden max-sm:inline">
                            ·{' '}
                          </span>
                          {formatRelativeTime(group.lastSeen)}
                        </TableCell>
                        <TableCell className="py-[var(--cell-py)] max-sm:order-2 max-sm:ms-auto max-sm:h-auto max-sm:py-1 max-sm:pl-1">
                          <ExceptionStateBadge state={group.state} />
                        </TableCell>
                        <TableCell
                          aria-hidden="true"
                          className="hidden max-sm:order-3 max-sm:block max-sm:h-0 max-sm:w-full max-sm:p-0"
                        />
                        <TableCell className="py-[var(--cell-py)] max-sm:hidden">
                          {trendBucketsByFamily[group.familyHash] ? (
                            <ExceptionTrend buckets={trendBucketsByFamily[group.familyHash]} />
                          ) : selectedGroup?.familyHash === group.familyHash ? (
                            <Skeleton
                              aria-label="Loading 24-hour occurrence trend"
                              className="h-6 w-22"
                            />
                          ) : (
                            <span className="text-xs text-ink-4">—</span>
                          )}
                        </TableCell>
                        <TableCell
                          className="py-[var(--cell-py)] max-sm:order-6 max-sm:ms-auto max-sm:h-auto max-sm:py-0 max-sm:pl-1 max-sm:pr-2"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <div className="flex items-center gap-0.5">
                            <Button
                              aria-label="Resolve exception family"
                              className="relative pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11"
                              disabled={
                                triagePending.has(group.familyHash) || group.state === 'resolved'
                              }
                              onClick={() => void setGroupState(group, 'resolved')}
                              size="icon-xs"
                              title="Resolve"
                              type="button"
                              variant="ghost"
                            >
                              <Check aria-hidden="true" />
                            </Button>
                            <Button
                              aria-label="Ignore exception family"
                              className="relative pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11"
                              disabled={
                                triagePending.has(group.familyHash) || group.state === 'ignored'
                              }
                              onClick={() => void setGroupState(group, 'ignored')}
                              size="icon-xs"
                              title="Ignore"
                              type="button"
                              variant="ghost"
                            >
                              <EyeOff aria-hidden="true" />
                            </Button>
                            <Button
                              aria-label="Reopen exception family"
                              className="relative pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11"
                              disabled={
                                triagePending.has(group.familyHash) || group.state === 'open'
                              }
                              onClick={() => void setGroupState(group, 'open')}
                              size="icon-xs"
                              title="Reopen"
                              type="button"
                              variant="ghost"
                            >
                              <RotateCcw aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="py-[var(--cell-py)] max-sm:hidden">
                          <ArrowUpRight aria-hidden="true" className="size-4 text-ink-3" />
                        </TableCell>
                      </TableRow>
                    )
                  })}
              </TableBody>
            </Table>
          </div>

          {!indexLoading && error && visibleGroups.length === 0 && (
            <Empty className="border-0 py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CircleAlert aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Exception groups could not be loaded</EmptyTitle>
                <EmptyDescription>{error.message}</EmptyDescription>
              </EmptyHeader>
              <Button onClick={() => void loadInitial()} variant="outline">
                Try again
              </Button>
            </Empty>
          )}

          {!indexLoading && !error && visibleGroups.length === 0 && (
            <Empty className="border-0 py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>
                  {tag ? 'No matching exception families' : 'No exceptions recorded'}
                </EmptyTitle>
                <EmptyDescription>
                  {tag
                    ? `No exception occurrence carries the exact tag “${tag}”.`
                    : 'Unhandled errors and reported exceptions will be grouped here by stack signature.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {!indexLoading && visibleGroups.length > 0 && filteredGroups.length === 0 && (
            <Empty className="border-0 py-16">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No {stateFilter} exception families</EmptyTitle>
                <EmptyDescription>
                  Choose another triage state to inspect the remaining exception families.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {visibleGroups.length > 0 && (
            <div className="flex items-center justify-between border-t border-edge bg-well px-2.5 py-1.5">
              <span className="num text-micro text-ink-3">
                {filteredGroups.length.toLocaleString()} of {visibleGroups.length.toLocaleString()}{' '}
                groups shown
              </span>
              {nextCursor && (
                <Button
                  loading={loadingMore}
                  onClick={() => void loadMore()}
                  size="xs"
                  variant="ghost"
                >
                  <ArrowDown aria-hidden="true" /> Load older
                </Button>
              )}
            </div>
          )}
        </PanelBody>
      </Panel>

      {error && visibleGroups.length > 0 && (
        <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-destructive/5 px-3 py-2 text-sm text-destructive-foreground max-sm:flex-wrap">
          <span className="min-w-0 break-words">{error.message}</span>
          <Button onClick={() => void loadInitial()} size="sm" variant="ghost">
            Retry
          </Button>
        </div>
      )}
      {triageError && (
        <div
          className="flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-destructive/5 px-3 py-2 text-sm text-destructive-foreground max-sm:flex-wrap"
          role="alert"
        >
          <span className="min-w-0 break-words">
            {triageError.message}. The exception family was returned to its previous state.
          </span>
          <Button onClick={() => setTriageError(null)} size="sm" variant="ghost">
            Dismiss
          </Button>
        </div>
      )}

      <EntryDetailScope entry={selectedOccurrence}>
        <EntryDetailDrawer
          description={
            selectedOccurrence
              ? formatDateTime(selectedOccurrence.createdAt)
              : 'Exception occurrence'
          }
          meta={
            current && (
              <>
                <StatusBadge status={current.status} />
                {current.code && <Badge variant="secondary">{current.code}</Badge>}
              </>
            )
          }
          onOpenChange={(open) => !open && setSelectedGroup(null)}
          open={selectedGroup !== null}
          tags={selectedOccurrence?.tags}
          title={
            current ? `${current.name}: ${truncate(current.message, 100)}` : 'Exception detail'
          }
        >
          {selectedGroup && (
            <>
              {occurrencesLoading && <Skeleton className="h-40 w-full" />}
              {occurrencesError && (
                <p className="rounded-lg border bg-destructive/5 p-3 text-sm text-destructive-foreground">
                  {occurrencesError.message}
                </p>
              )}
              {current && selectedOccurrence && (
                <>
                  <ExceptionOccurrenceContent entry={selectedOccurrence} />

                  <section className="min-w-0 overflow-hidden rounded-lg border">
                    <div className="flex items-center justify-between border-b px-3 py-2">
                      <h3 className="text-sm font-semibold">Occurrences</h3>
                      <Badge variant="secondary">
                        {selectedGroup.count.toLocaleString()} total
                      </Badge>
                    </div>
                    <div className="divide-y">
                      {occurrences.map((entry) => {
                        const occurrence = exceptionContent(entry)
                        const active = selectedOccurrence.uuid === entry.uuid
                        return (
                          <div
                            className={`flex items-center gap-2 p-2 ${active ? 'bg-accent/55' : ''}`}
                            key={entry.uuid}
                          >
                            <button
                              className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => setSelectedOccurrence(entry)}
                              type="button"
                            >
                              <span
                                className="block truncate text-xs font-medium"
                                title={occurrence.message}
                              >
                                {occurrence.message}
                              </span>
                              <span className="mt-0.5 block text-2xs text-muted-foreground">
                                {formatDateTime(entry.createdAt)}
                              </span>
                            </button>
                            <Button
                              aria-label="Open occurrence request batch"
                              render={
                                <Link to={`/requests/${encodeURIComponent(entry.batchId)}`} />
                              }
                              size="icon-xs"
                              variant="ghost"
                            >
                              <ArrowUpRight aria-hidden="true" />
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                    {occurrencesNextCursor && (
                      <div className="flex justify-center border-t p-2">
                        <Button
                          loading={occurrencesLoadingMore}
                          onClick={() => void loadMoreOccurrences()}
                          size="sm"
                          variant="ghost"
                        >
                          <ArrowDown aria-hidden="true" />
                          Load older occurrences
                        </Button>
                      </div>
                    )}
                  </section>
                </>
              )}
            </>
          )}
        </EntryDetailDrawer>
      </EntryDetailScope>
    </div>
  )
}
