import { ArrowDown, ArrowUpRight, CircleAlert, Inbox, RefreshCw, Route } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import { JsonTree } from '@/components/json-tree'
import { PageHeader } from '@/components/page-header'
import { StackTrace } from '@/components/stack-trace'
import { StatusBadge } from '@/components/status-badge'
import { TagChip } from '@/components/tag-chip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Frame, FramePanel } from '@/components/ui/frame'
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
import { useDashboard } from '@/dashboard-context'
import { usePolling } from '@/hooks/use-polling'
import { walkCursorPages } from '@/hooks/walk-cursor-pages'
import { api } from '@/lib/api'
import { isNewExceptionGroup, mergeExceptionGroups } from '@/lib/exception-groups'
import { shouldPollForUpdates } from '@/lib/live-updates'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { ExceptionContent, ExceptionGroup, StoredEntry } from '@/types'

function exceptionContent(entry: StoredEntry): ExceptionContent {
  return entry.content as ExceptionContent
}

export function ExceptionsPage() {
  const [searchParams] = useSearchParams()
  const { status, revision, liveUpdateMode, flushEvent, flushRevision, selectedApplication } =
    useDashboard()
  const tag = searchParams.get('tag')?.trim() || undefined
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
  const groupsRef = useRef(groups)
  const pendingGroupsRef = useRef(pendingGroups)
  const requestGenerationRef = useRef(0)
  const pollingGenerationRef = useRef(0)
  const listControllerRef = useRef<AbortController | null>(null)
  const pollingControllerRef = useRef<AbortController | null>(null)
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

  const visibleGroups = scopeChanged ? [] : groups
  const visiblePendingGroups = scopeChanged ? [] : pendingGroups
  const pendingNewCount = visiblePendingGroups.reduce((total, group) => {
    const current = visibleGroups.find((candidate) => candidate.familyHash === group.familyHash)
    return total + Math.max(1, group.count - (current?.count ?? 0))
  }, 0)

  const loadMore = async () => {
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
  }
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
  const openGroup = (group: ExceptionGroup) => {
    setSelectedOccurrence(group.latest)
    setSelectedGroup(group)
  }

  return (
    <div className="space-y-4">
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

      <Frame className="rounded-lg p-0.5">
        <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
        <div className="overflow-x-auto">
          <Table className="min-w-data-table text-xs">
            <TableCaption className="sr-only">Grouped recorded exceptions</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 px-2.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  Latest exception
                </TableHead>
                <TableHead className="h-8 w-28 px-2.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  Status
                </TableHead>
                <TableHead className="h-8 w-28 px-2.5 text-right text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  Occurrences
                </TableHead>
                <TableHead className="h-8 w-36 px-2.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  Last seen
                </TableHead>
                <TableHead className="h-8 w-10 px-2.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  <span className="sr-only">Open details</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {indexLoading &&
                Array.from({ length: 7 }, (_, index) => (
                  <TableRow key={index}>
                    <TableCell className="px-2.5 py-2">
                      <Skeleton className="h-8 w-full max-w-xl" />
                    </TableCell>
                    <TableCell className="px-2.5 py-2">
                      <Skeleton className="h-5 w-14" />
                    </TableCell>
                    <TableCell className="px-2.5 py-2">
                      <Skeleton className="ms-auto h-5 w-10" />
                    </TableCell>
                    <TableCell className="px-2.5 py-2">
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                    <TableCell className="px-2.5 py-2" />
                  </TableRow>
                ))}
              {!indexLoading &&
                visibleGroups.map((group) => {
                  const content = exceptionContent(group.latest)
                  return (
                    <TableRow
                      className="cursor-pointer hover:bg-accent/45"
                      key={group.familyHash}
                      onClick={() => openGroup(group)}
                    >
                      <TableCell className="px-2.5 py-2">
                        <button
                          className="block w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          type="button"
                        >
                          <span className="sr-only">
                            Inspect {content.name}: {content.message}.{' '}
                          </span>
                          <span className="block max-w-2xl">
                            <span className="block truncate text-sm font-medium">
                              {content.message}
                            </span>
                            <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{content.name}</span>
                              {content.code && <span className="font-mono">{content.code}</span>}
                            </span>
                          </span>
                        </button>
                      </TableCell>
                      <TableCell className="px-2.5 py-2">
                        <StatusBadge status={content.status} />
                      </TableCell>
                      <TableCell className="px-2.5 py-2 text-right font-mono text-sm font-semibold tabular-nums">
                        {group.count.toLocaleString()}
                      </TableCell>
                      <TableCell className="whitespace-nowrap px-2.5 py-2 text-xs text-muted-foreground">
                        {formatRelativeTime(group.lastSeen)}
                      </TableCell>
                      <TableCell className="px-2.5 py-2">
                        <ArrowUpRight aria-hidden="true" className="size-4 text-muted-foreground" />
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

        {visibleGroups.length > 0 && (
          <div className="flex items-center justify-between border-t bg-muted/40 px-2.5 py-1.5">
            <span className="font-mono text-2xs tabular-nums text-muted-foreground">
              {visibleGroups.length.toLocaleString()} groups loaded
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
        </FramePanel>
      </Frame>

      {error && visibleGroups.length > 0 && (
        <div className="flex items-center justify-between rounded-lg border bg-destructive/5 px-3 py-2 text-sm text-destructive-foreground">
          <span>{error.message}</span>
          <Button onClick={() => void loadInitial()} size="sm" variant="ghost">
            Retry
          </Button>
        </div>
      )}

      <EntryDetailDrawer
        description={
          selectedOccurrence ? formatDateTime(selectedOccurrence.createdAt) : 'Exception occurrence'
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
        title={current ? `${current.name}: ${truncate(current.message, 100)}` : 'Exception detail'}
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
                {current.request && (
                  <section className="rounded-md border bg-muted/25 p-3">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <Route aria-hidden="true" className="size-4 text-primary" />
                      {current.request.method} {current.request.url}
                    </div>
                    {current.request.route && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {current.request.route.pattern}
                        {current.request.route.name ? ` · ${current.request.route.name}` : ''}
                      </p>
                    )}
                  </section>
                )}

                <StackTrace
                  codeFrame={current.codeFrame}
                  fallback={current.stack}
                  frames={current.frames ?? []}
                />

                {current.context !== undefined && (
                  <JsonTree label="Exception context" value={current.context} />
                )}

                <section className="overflow-hidden rounded-lg border">
                  <div className="flex items-center justify-between border-b px-3 py-2">
                    <h3 className="text-sm font-semibold">Occurrences</h3>
                    <Badge variant="secondary">{selectedGroup.count.toLocaleString()} total</Badge>
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
                            <span className="block truncate text-xs font-medium">
                              {occurrence.message}
                            </span>
                            <span className="mt-0.5 block text-2xs text-muted-foreground">
                              {formatDateTime(entry.createdAt)}
                            </span>
                          </button>
                          <Button
                            aria-label="Open occurrence request batch"
                            render={<Link to={`/requests/${encodeURIComponent(entry.batchId)}`} />}
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

                <dl className="grid gap-2.5 rounded-md border p-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">Family hash</dt>
                    <dd
                      className="mt-0.5 truncate font-mono text-xs"
                      title={selectedGroup.familyHash}
                    >
                      {selectedGroup.familyHash}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Sequence</dt>
                    <dd className="mt-0.5 truncate font-mono text-xs">
                      {selectedOccurrence.sequence}
                    </dd>
                  </div>
                </dl>
              </>
            )}
          </>
        )}
      </EntryDetailDrawer>
    </div>
  )
}
