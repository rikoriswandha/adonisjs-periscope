import { Activity, ArrowUpRight, Bug, Database, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  Metric,
  Panel,
  PanelBody,
  PanelHeader,
  SIGNAL_TEXT,
  SignalMeter,
  StatusDot,
} from '@/components/instrument'
import type { Signal } from '@/components/instrument'
import { PageHeader } from '@/components/page-header'
import { RequestActivityChart } from '@/components/request-activity-chart'
import { Skeleton } from '@/components/ui/skeleton'
import { useDashboard } from '@/dashboard-context'
import { usePolling } from '@/hooks/use-polling'
import { api } from '@/lib/api'
import type { DashboardStats } from '@/lib/api'
import { formatDuration, formatRelativeTime, truncate } from '@/lib/format'
import type {
  EntryType,
  ExceptionContent,
  ExceptionGroup,
  ExceptionGroupState,
  StoredEntry,
} from '@/types'
import { wave2EntryTypes } from '@/wave2-entry-types'

type CountLink = {
  type: EntryType
  path: string
  label: string
}

const countLinks: CountLink[] = [
  { type: 'request', path: 'requests', label: 'Requests' },
  { type: 'query', path: 'queries', label: 'Queries' },
  { type: 'exception', path: 'exceptions', label: 'Exceptions' },
  ...wave2EntryTypes.map((registration) => ({
    type: registration.type,
    path: registration.path,
    label: registration.label,
  })),
]

function exceptionStateSignal(state: ExceptionGroupState): Signal {
  if (state === 'open') return 'error'
  if (state === 'resolved') return 'ok'
  return 'neutral'
}

function OverviewLoading() {
  return (
    <div className="mt-4" aria-label="Loading overview" aria-live="polite" role="status">
      <Panel className="overflow-hidden">
        <div className="grid grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div
              className="border-edge p-4 odd:border-r nth-[n+3]:border-t lg:border-r lg:nth-[n+3]:border-t-0 lg:last:border-r-0"
              key={index}
            >
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-7 w-24" />
              <Skeleton className="mt-2 h-3 w-28" />
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="mt-4 overflow-hidden">
        <PanelHeader title="Request activity" />
        <PanelBody>
          <Skeleton className="h-[200px] w-full" />
        </PanelBody>
      </Panel>

      <section className="mt-6" aria-label="Loading items needing attention">
        <Skeleton className="h-5 w-36" />
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {[0, 1].map((index) => (
            <Panel className="overflow-hidden" key={index}>
              <PanelHeader title={index === 0 ? 'Recent exception families' : 'Slow query families'} />
              <PanelBody className="space-y-3">
                {[0, 1, 2].map((row) => (
                  <div className="flex min-h-11 items-center gap-3" key={row}>
                    <Skeleton className="h-3 flex-1" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                ))}
              </PanelBody>
            </Panel>
          ))}
        </div>
      </section>

      <Panel className="mt-6 overflow-hidden">
        <PanelHeader title="Watcher coverage" />
        <PanelBody className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-px bg-edge p-0">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
            <Skeleton className="h-[var(--row-h)] rounded-none" key={index} />
          ))}
        </PanelBody>
      </Panel>
    </div>
  )
}

export function OverviewPage() {
  const { counts, flushRevision, revision, selectedApplication, status } = useDashboard()
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
  const slowQueryCountMax = Math.max(
    0,
    ...(visibleStats?.slowQueryFamilies.map((family) => family.count) ?? [])
  )

  return (
    <div>
      <PageHeader
        description={`A live operational summary of recorded activity for ${selectedApplication}.`}
        title="Overview"
      />

      {error && (
        <div
          className="mt-3 flex items-start justify-between gap-3 rounded-sm border border-sig-error/25 bg-sig-error/5 px-3 py-2.5 text-xs text-sig-error"
          role="alert"
        >
          <span className="flex min-w-0 items-start gap-2">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>{error.message}</span>
          </span>
          <button
            className="shrink-0 font-medium underline underline-offset-4 transition-colors hover:text-ink active:text-ink-2 disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:min-h-11"
            onClick={() => void loadOverview()}
            type="button"
          >
            Retry
          </button>
        </div>
      )}

      {!visibleStats && !error ? (
        <OverviewLoading />
      ) : visibleStats ? (
        <div className="mt-4">
          <Panel className="overflow-hidden" aria-label="Request vitals">
            <div className="grid grid-cols-2 lg:grid-cols-4">
              <Metric
                className="border-edge p-4 border-r border-b lg:border-b-0"
                detail="Current stats sample"
                label="Sampled requests"
                value={visibleStats.requests.sampled.toLocaleString()}
              />
              <Metric
                className="border-edge p-4 border-b lg:border-r lg:border-b-0"
                detail={
                  <span className="num max-sm:block max-sm:whitespace-normal">
                    {visibleStats.requests.errorCount.toLocaleString()} errors /{' '}
                    {visibleStats.requests.sampled.toLocaleString()} sampled
                  </span>
                }
                label="Error rate"
                signal={requestErrorRate > 0 ? 'error' : 'ok'}
                unit="%"
                value={requestErrorRate.toFixed(1)}
              />
              <Metric
                className="border-edge p-4 border-r lg:border-r"
                detail={
                  <span className="max-sm:block max-sm:whitespace-normal">
                    Across{' '}
                    <span className="num">{visibleStats.requests.sampled.toLocaleString()}</span>{' '}
                    sampled requests
                  </span>
                }
                label="p50 latency"
                value={formatDuration(visibleStats.requests.p50)}
              />
              <Metric
                className="p-4"
                detail={
                  <span className="max-sm:block max-sm:whitespace-normal">
                    Across{' '}
                    <span className="num">{visibleStats.requests.sampled.toLocaleString()}</span>{' '}
                    sampled requests
                  </span>
                }
                label="p95 latency"
                value={formatDuration(visibleStats.requests.p95)}
              />
            </div>
          </Panel>

          <div className="mt-4">
            {visibleRequestEntries.length < 2 ? (
              <Panel className="overflow-hidden">
                <PanelHeader
                  icon={<Activity aria-hidden="true" className="size-3.5" />}
                  meta={<span className="num">{visibleRequestEntries.length} samples</span>}
                  title="Request activity"
                />
                <PanelBody className="flex min-h-32 items-center justify-center">
                  <p className="max-w-lg text-center text-prose text-ink-3">
                    Request activity will appear here after at least two requests have been
                    recorded.
                  </p>
                </PanelBody>
              </Panel>
            ) : (
              <RequestActivityChart entries={visibleRequestEntries} />
            )}
          </div>

          <section className="mt-6" aria-labelledby="attention-title">
            <div>
              <h2 className="text-md font-medium text-ink" id="attention-title">
                Needs attention
              </h2>
              <p className="mt-1 text-sm text-ink-3">
                Repeated failures and expensive database work from the current sample.
              </p>
            </div>

            <div className="mt-3 grid items-start gap-3 lg:grid-cols-2">
              <Panel className="overflow-hidden" aria-label="Recent exception families">
                <PanelHeader
                  action={
                    <Link
                      className="flex min-h-[var(--control-h)] items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink active:text-ink-2 [@media(pointer:coarse)]:min-h-11"
                      to={`/exceptions${applicationQuery}`}
                    >
                      View all
                      <ArrowUpRight aria-hidden="true" className="size-3.5" />
                    </Link>
                  }
                  icon={<Bug aria-hidden="true" className="size-3.5" />}
                  meta={
                    <span className="num">
                      {visibleExceptionGroups.length}{' '}
                      {visibleExceptionGroups.length === 1 ? 'family' : 'families'}
                    </span>
                  }
                  title="Recent exception families"
                />
                {visibleExceptionGroups.length === 0 ? (
                  <PanelBody className="flex min-h-40 items-center justify-center">
                    <p className="max-w-sm text-center text-prose text-ink-3">
                      No exceptions recorded yet — they&apos;ll appear here as your app runs.
                    </p>
                  </PanelBody>
                ) : (
                  <div className="divide-y divide-edge">
                    {visibleExceptionGroups.map((group) => {
                      const content = group.latest.content as ExceptionContent
                      const stateSignal = exceptionStateSignal(group.state)
                      return (
                        <Link
                          className="group grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-[var(--cell-py)] transition-colors hover:bg-panel-raised active:bg-well focus-visible:bg-panel-raised [@media(pointer:coarse)]:min-h-11"
                          key={group.familyHash}
                          to={`/entries/${encodeURIComponent(group.latest.uuid)}${applicationQuery}`}
                        >
                          <StatusDot signal="error" />
                          <span className="min-w-0">
                            <span
                              className="block truncate text-sm text-ink-2 group-hover:text-ink"
                              title={content.message || 'Exception without a message'}
                            >
                              {truncate(content.message || 'Exception without a message', 120)}
                            </span>
                            <span className="num mt-0.5 block text-micro text-ink-3 sm:hidden">
                              {formatRelativeTime(group.lastSeen)}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-3 text-right">
                            <span className="num text-xs text-ink-2">
                              ×{group.count.toLocaleString()}
                            </span>
                            <span className="num hidden text-xs text-ink-3 sm:inline">
                              {formatRelativeTime(group.lastSeen)}
                            </span>
                            <span
                              className={`w-14 text-xs capitalize ${SIGNAL_TEXT[stateSignal]}`}
                            >
                              {group.state}
                            </span>
                          </span>
                        </Link>
                      )
                    })}
                  </div>
                )}
              </Panel>

              <Panel className="overflow-hidden" aria-label="Slow query families">
                <PanelHeader
                  action={
                    <Link
                      className="flex min-h-[var(--control-h)] items-center gap-1 text-xs text-ink-3 transition-colors hover:text-ink active:text-ink-2 [@media(pointer:coarse)]:min-h-11"
                      to={`/queries${applicationQuery}`}
                    >
                      Inspect
                      <ArrowUpRight aria-hidden="true" className="size-3.5" />
                    </Link>
                  }
                  icon={<Database aria-hidden="true" className="size-3.5" />}
                  meta={
                    <span className="num">
                      {visibleStats.slowQueryFamilies.length}{' '}
                      {visibleStats.slowQueryFamilies.length === 1 ? 'family' : 'families'}
                    </span>
                  }
                  title="Slow query families"
                />
                {visibleStats.slowQueryFamilies.length === 0 ? (
                  <PanelBody className="flex min-h-40 items-center justify-center">
                    <p className="max-w-sm text-center text-prose text-ink-3">
                      No slow queries recorded yet — queries over your slow threshold will appear
                      here.
                    </p>
                  </PanelBody>
                ) : (
                  <div>
                    <div className="micro-label hidden grid-cols-[minmax(0,1fr)_5rem_5.5rem_5.5rem] gap-3 border-b border-edge bg-well px-3 py-1.5 sm:grid">
                      <span>SQL shape</span>
                      <span className="text-right">Count</span>
                      <span className="text-right">Average</span>
                      <span className="text-right">Maximum</span>
                    </div>
                    <div className="divide-y divide-edge">
                      {visibleStats.slowQueryFamilies.map((family) => (
                        <Link
                          className="grid min-h-11 grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-x-3 gap-y-1.5 px-3 py-[var(--cell-py)] transition-colors hover:bg-panel-raised active:bg-well focus-visible:bg-panel-raised sm:grid-cols-[minmax(0,1fr)_5rem_5.5rem_5.5rem] [@media(pointer:coarse)]:min-h-11"
                          key={family.familyHash}
                          to={`/queries${applicationQuery}`}
                        >
                          <span className="min-w-0">
                            <span
                              className="num block truncate text-xs text-ink-2"
                              title={family.sql || 'SQL shape unavailable'}
                            >
                              {family.sql || 'SQL shape unavailable'}
                            </span>
                            <span
                              className="num block truncate text-micro text-ink-4"
                              title={family.familyHash}
                            >
                              {family.familyHash}
                            </span>
                          </span>
                          <span className="flex min-w-0 flex-col items-end gap-1">
                            <span className="num text-xs text-ink-2">
                              {family.count.toLocaleString()}
                            </span>
                            <SignalMeter
                              className="w-full"
                              max={slowQueryCountMax}
                              signal="warn"
                              value={family.count}
                            />
                          </span>
                          <span className="num text-xs text-ink-3 max-sm:col-start-1">
                            <span className="mr-1 text-ink-3 sm:hidden">avg</span>
                            {formatDuration(family.avgDurationMs)}
                          </span>
                          <span className="num text-xs text-ink-3 max-sm:text-right">
                            <span className="mr-1 text-ink-3 sm:hidden">max</span>
                            {formatDuration(family.maxDurationMs)}
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </Panel>
            </div>
          </section>

          <Panel className="mt-6 overflow-hidden" aria-label="Watcher coverage">
            <PanelHeader
              meta={<span className="num">{totalEntries.toLocaleString()} total entries</span>}
              title="Watcher coverage"
            />
            <PanelBody className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-px bg-edge p-0">
              {countLinks.map((item) => {
                const count = counts[item.type] ?? 0
                const populated = count > 0
                return (
                  <Link
                    className={`group flex min-h-[var(--row-h)] min-w-0 items-center gap-2 bg-panel px-3 py-[var(--cell-py)] transition-colors hover:bg-panel-raised active:bg-well focus-visible:bg-panel-raised [@media(pointer:coarse)]:min-h-11 ${
                      populated ? 'text-ink-2' : 'text-ink-4'
                    }`}
                    key={item.type}
                    to={`/${item.path}${applicationQuery}`}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs group-hover:text-ink">
                      {item.label}
                    </span>
                    <span className="text-ink-4" aria-hidden="true">
                      ·
                    </span>
                    <span className="num shrink-0 text-xs">{count.toLocaleString()}</span>
                  </Link>
                )
              })}
            </PanelBody>
          </Panel>
        </div>
      ) : null}
    </div>
  )
}
