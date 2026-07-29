import {
  Activity,
  ArrowUpRight,
  Bug,
  Clock3,
  Database,
  Gauge,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { PageHeader } from '@/components/page-header'
import { RequestActivityChart } from '@/components/request-activity-chart'
import { Frame, FramePanel } from '@/components/ui/frame'
import { Skeleton } from '@/components/ui/skeleton'
import { useDashboard } from '@/dashboard-context'
import { usePolling } from '@/hooks/use-polling'
import { api } from '@/lib/api'
import type { DashboardStats } from '@/lib/api'
import { formatDuration, formatRelativeTime, truncate } from '@/lib/format'
import type { EntryType, ExceptionContent, ExceptionGroup, StoredEntry } from '@/types'
import { wave2EntryTypes } from '@/wave2-entry-types'

type CountLink = {
  type: EntryType
  path: string
  label: string
  icon: LucideIcon
}

const coreCountLinks: CountLink[] = [
  { type: 'request', path: 'requests', label: 'Requests', icon: Gauge },
  { type: 'query', path: 'queries', label: 'Queries', icon: Database },
  { type: 'exception', path: 'exceptions', label: 'Exceptions', icon: Bug },
]

const countLinks: CountLink[] = [
  ...coreCountLinks,
  ...wave2EntryTypes.map((registration) => ({
    type: registration.type,
    path: registration.path,
    label: registration.label,
    icon: registration.icon,
  })),
]

function OverviewLoading() {
  return (
    <div className="space-y-4" aria-label="Loading overview" role="status">
      <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Skeleton className="h-24 rounded-none" key={index} />
        ))}
      </div>
      <Skeleton className="h-52 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

export function OverviewPage() {
  const {
    counts,
    flushRevision,
    revision,
    selectedApplication,
    status,
  } = useDashboard()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [exceptionGroups, setExceptionGroups] = useState<ExceptionGroup[]>([])
  const [requestEntries, setRequestEntries] = useState<StoredEntry[]>([])
  const [loadedScope, setLoadedScope] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const scope = `${selectedApplication}:${revision}`
  const applicationQuery = `?application=${encodeURIComponent(selectedApplication)}`

  const loadOverview = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    const generation = ++generationRef.current
    requestRef.current = controller

    try {
      const [nextStats, exceptionPage, requestPage] = await Promise.all([
        api.getStats(selectedApplication, controller.signal),
        api.getExceptionGroups(
          { application: selectedApplication, limit: 5 },
          controller.signal
        ),
        api.listEntries(
          {
            type: 'request',
            application: selectedApplication,
            displayOnIndex: true,
            limit: 100,
          },
          controller.signal
        ),
      ])
      if (controller.signal.aborted || generation !== generationRef.current) return
      setStats(nextStats)
      setExceptionGroups(exceptionPage.data)
      setRequestEntries(requestPage.data)
      setLoadedScope(scope)
      setError(null)
    } catch (cause) {
      if (controller.signal.aborted || generation !== generationRef.current) return
      setError(cause instanceof Error ? cause : new Error('Unable to load overview'))
    } finally {
      if (requestRef.current === controller) requestRef.current = null
    }
  }, [scope, selectedApplication])

  useEffect(() => {
    generationRef.current += 1
    requestRef.current?.abort()
    setLoadedScope(null)
    setError(null)
    if (document.visibilityState === 'visible') void loadOverview()
    return () => {
      generationRef.current += 1
      requestRef.current?.abort()
    }
  }, [loadOverview])

  useEffect(() => {
    if (flushRevision > 0 && status?.paused === false && document.visibilityState === 'visible') {
      void loadOverview()
    }
  }, [flushRevision, loadOverview, status?.paused])

  usePolling(loadOverview, {
    enabled: status?.paused !== true,
    interval: 5_000,
  })

  const visibleStats = loadedScope === scope ? stats : null
  const visibleExceptionGroups = loadedScope === scope ? exceptionGroups : []
  const visibleRequestEntries = loadedScope === scope ? requestEntries : []
  const requestErrorRate = visibleStats?.requests.sampled
    ? (visibleStats.requests.errorCount / visibleStats.requests.sampled) * 100
    : 0
  const totalEntries = useMemo(
    () => Object.values(counts).reduce<number>((total, count) => total + (count ?? 0), 0),
    [counts]
  )

  return (
    <div className="space-y-4">
      <PageHeader
        description={`A live operational summary of recorded activity for ${selectedApplication}.`}
        title="Overview"
      />

      {error && (
        <div
          className="flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2.5 text-xs text-destructive-foreground"
          role="alert"
        >
          <span className="flex min-w-0 items-start gap-2">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>{error.message}</span>
          </span>
          <button
            className="shrink-0 font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void loadOverview()}
            type="button"
          >
            Retry
          </button>
        </div>
      )}

      {!visibleStats && !error ? (
        <OverviewLoading />
      ) : (
        <>
          <Frame className="rounded-lg p-0.5" aria-labelledby="request-health-title">
            <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2.5">
                <div>
                  <h2 className="flex items-center gap-2 text-xs font-semibold" id="request-health-title">
                    <Activity aria-hidden="true" className="size-3.5 text-primary" />
                    Request health
                  </h2>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    Latest {visibleStats?.requests.sampled.toLocaleString() ?? 0} recorded requests
                  </p>
                </div>
                <Link
                  className="flex items-center gap-1 text-2xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  to={`/requests${applicationQuery}`}
                >
                  Inspect requests
                  <ArrowUpRight aria-hidden="true" className="size-3.5" />
                </Link>
              </div>
              <dl className="grid gap-px bg-border sm:grid-cols-3">
                <div className="bg-background px-3 py-3">
                  <dt className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
                    <Clock3 aria-hidden="true" className="size-3.5" /> p50 latency
                  </dt>
                  <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">
                    {formatDuration(visibleStats?.requests.p50)}
                  </dd>
                </div>
                <div className="bg-background px-3 py-3">
                  <dt className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
                    <Zap aria-hidden="true" className="size-3.5" /> p95 latency
                  </dt>
                  <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">
                    {formatDuration(visibleStats?.requests.p95)}
                  </dd>
                </div>
                <div className="bg-background px-3 py-3">
                  <dt className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
                    <TriangleAlert aria-hidden="true" className="size-3.5" /> Error rate
                  </dt>
                  <dd className="mt-1 font-mono text-xl font-semibold tabular-nums">
                    {requestErrorRate.toFixed(1)}%
                  </dd>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    {visibleStats?.requests.errorCount.toLocaleString() ?? 0} server errors
                  </p>
                </div>
              </dl>
            </FramePanel>
          </Frame>

          <RequestActivityChart entries={visibleRequestEntries} />

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
            <Frame className="rounded-lg p-0.5" aria-labelledby="entry-counts-title">
              <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
                <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
                  <div>
                    <h2 className="text-xs font-semibold" id="entry-counts-title">Recorded entries</h2>
                    <p className="mt-0.5 text-2xs text-muted-foreground">
                      {totalEntries.toLocaleString()} entries across watcher types
                    </p>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-2">
                  {countLinks.map((item) => {
                    const Icon = item.icon
                    const count = counts[item.type] ?? 0
                    return (
                      <Link
                        className="group flex min-w-0 items-center gap-2.5 border-b border-r px-3 py-2.5 outline-none transition-colors last:border-b-0 hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        key={item.type}
                        to={`/${item.path}${applicationQuery}`}
                      >
                        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground group-hover:text-foreground">
                          <Icon aria-hidden="true" className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{item.label}</span>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {count.toLocaleString()}
                        </span>
                      </Link>
                    )
                  })}
                </div>
              </FramePanel>
            </Frame>

            <Frame className="rounded-lg p-0.5" aria-labelledby="recent-exceptions-title">
              <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
                <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
                  <div>
                    <h2 className="text-xs font-semibold" id="recent-exceptions-title">Recent exceptions</h2>
                    <p className="mt-0.5 text-2xs text-muted-foreground">Newest exception families</p>
                  </div>
                  <Link
                    className="text-2xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    to={`/exceptions${applicationQuery}`}
                  >
                    View all
                  </Link>
                </div>
                {visibleExceptionGroups.length === 0 ? (
                  <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                    No exceptions recorded for this application.
                  </p>
                ) : (
                  <div className="divide-y">
                    {visibleExceptionGroups.map((group) => {
                      const content = group.latest.content as ExceptionContent
                      return (
                        <Link
                          className="group flex items-start gap-2.5 px-3 py-2.5 outline-none transition-colors hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          key={group.familyHash}
                          to={`/entries/${encodeURIComponent(group.latest.uuid)}${applicationQuery}`}
                        >
                          <Bug aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium">
                              {content.name || 'Exception'}
                            </span>
                            <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                              {truncate(content.message || 'No exception message', 100)}
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="block font-mono text-2xs tabular-nums">×{group.count}</span>
                            <span className="mt-0.5 block text-2xs text-muted-foreground">
                              {formatRelativeTime(group.lastSeen)}
                            </span>
                          </span>
                        </Link>
                      )
                    })}
                  </div>
                )}
              </FramePanel>
            </Frame>
          </div>

          <Frame className="rounded-lg p-0.5" aria-labelledby="slow-query-title">
            <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2.5">
                <div>
                  <h2 className="flex items-center gap-2 text-xs font-semibold" id="slow-query-title">
                    <Database aria-hidden="true" className="size-3.5 text-warning" />
                    Slow query families
                  </h2>
                  <p className="mt-0.5 text-2xs text-muted-foreground">
                    Most frequent shapes in the latest 500 slow queries
                  </p>
                </div>
                <Link
                  className="flex items-center gap-1 text-2xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  to={`/queries?tag=slow&application=${encodeURIComponent(selectedApplication)}`}
                >
                  Inspect slow queries
                  <ArrowUpRight aria-hidden="true" className="size-3.5" />
                </Link>
              </div>
              {visibleStats?.slowQueryFamilies.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No slow queries in the current sample.
                </p>
              ) : (
                <div className="divide-y">
                  <div className="hidden grid-cols-[minmax(0,1fr)_5rem_7rem_7rem] gap-3 bg-muted/60 px-3 py-2 text-2xs font-medium text-muted-foreground sm:grid">
                    <span>SQL sample</span>
                    <span className="text-right">Count</span>
                    <span className="text-right">Average</span>
                    <span className="text-right">Maximum</span>
                  </div>
                  {visibleStats?.slowQueryFamilies.map((family) => (
                    <Link
                      className="grid gap-1 px-3 py-2.5 outline-none transition-colors hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_5rem_7rem_7rem] sm:items-center sm:gap-3"
                      key={family.familyHash}
                      to={`/queries?tag=slow&application=${encodeURIComponent(selectedApplication)}`}
                    >
                      <span className="min-w-0 truncate font-mono text-xs" title={family.sql}>
                        {family.sql || family.familyHash}
                      </span>
                      <span className="font-mono text-2xs tabular-nums text-muted-foreground sm:text-right">
                        <span className="sm:hidden">Count </span>{family.count.toLocaleString()}
                      </span>
                      <span className="font-mono text-2xs tabular-nums text-muted-foreground sm:text-right">
                        <span className="sm:hidden">Avg </span>{formatDuration(family.avgDurationMs)}
                      </span>
                      <span className="font-mono text-2xs tabular-nums text-muted-foreground sm:text-right">
                        <span className="sm:hidden">Max </span>{formatDuration(family.maxDurationMs)}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </FramePanel>
          </Frame>
        </>
      )}
    </div>
  )
}
