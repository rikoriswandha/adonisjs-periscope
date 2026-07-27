import { Bug, CirclePause, Database, Gauge, Search, Trash2, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { DashboardContext } from '@/dashboard-context'
import { usePolling } from '@/hooks/use-polling'
import { api } from '@/lib/api'
import { globalSearchTarget } from '@/lib/global-search'
import { liveUpdateLabel, parseFlushStreamEvent } from '@/lib/live-updates'
import { normalizeMonitoredTags, setMonitoredTag } from '@/lib/monitored-tags'
import type {
  DashboardStatus,
  EntryCounts,
  EntryType,
  FlushStreamEvent,
  LiveUpdateMode,
} from '@/types'
import { wave2EntryTypes } from '@/wave2-entry-types'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Switch } from '@/components/ui/switch'

type NavigationItem = {
  to: string
  label: string
  type: EntryType
  icon: LucideIcon
}

const navigationGroups: { label: string; items: NavigationItem[] }[] = [
  {
    label: 'Core',
    items: [
      { to: '/requests', label: 'Requests', type: 'request', icon: Gauge },
      { to: '/queries', label: 'Queries', type: 'query', icon: Database },
      { to: '/exceptions', label: 'Exceptions', type: 'exception', icon: Bug },
    ],
  },
  ...(['Application', 'Diagnostics'] as const).map((label) => ({
    label,
    items: wave2EntryTypes
      .filter((registration) => registration.group === label)
      .map((registration) => ({
        to: `/${registration.path}`,
        label: registration.label,
        type: registration.type,
        icon: registration.icon,
      })),
  })),
]

const titleByPath: Record<string, string> = {
  requests: 'Requests',
  queries: 'Queries',
  exceptions: 'Exceptions',
  search: 'Search',
  ...Object.fromEntries(
    wave2EntryTypes.map((registration) => [registration.path, registration.label])
  ),
}

export function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const [status, setStatus] = useState<DashboardStatus | null>(null)
  const [counts, setCounts] = useState<EntryCounts>({})
  const [statusError, setStatusError] = useState<Error | null>(null)
  const [mutating, setMutating] = useState(false)
  const [revision, setRevision] = useState(0)
  const [liveUpdateMode, setLiveUpdateMode] = useState<LiveUpdateMode>('off')
  const [flushEvent, setFlushEvent] = useState<FlushStreamEvent | null>(null)
  const [flushRevision, setFlushRevision] = useState(0)
  const [monitoredTags, setMonitoredTags] = useState<string[]>([])
  const [monitoringTags, setMonitoringTags] = useState<string[]>([])
  const [monitoredTagsReady, setMonitoredTagsReady] = useState(false)
  const refreshGenerationRef = useRef(0)
  const monitoredTagsRef = useRef<string[]>([])
  const monitoredTagMutationGenerationRef = useRef(0)
  const monitoredTagMutationsRef = useRef(new Set<string>())
  const monitoredTagsRequestRef = useRef<AbortController | null>(null)
  const commitMonitoredTags = useCallback((update: (current: string[]) => string[]) => {
    const next = update(monitoredTagsRef.current)
    monitoredTagsRef.current = next
    setMonitoredTags(next)
  }, [])
  const activeNavigationRef = useRef<HTMLAnchorElement>(null)

  const refreshMonitoredTags = useCallback(async () => {
    if (monitoredTagMutationsRef.current.size > 0) return

    const generation = monitoredTagMutationGenerationRef.current
    const controller = new AbortController()
    monitoredTagsRequestRef.current = controller
    try {
      const tags = await api.getMonitoredTags(controller.signal)
      if (
        controller.signal.aborted ||
        generation !== monitoredTagMutationGenerationRef.current ||
        monitoredTagMutationsRef.current.size > 0
      ) {
        return
      }
      const next = normalizeMonitoredTags(tags)
      monitoredTagsRef.current = next
      setMonitoredTags(next)
    } catch (cause) {
      if (controller.signal.aborted || generation !== monitoredTagMutationGenerationRef.current) {
        return
      }
      setStatusError(cause instanceof Error ? cause : new Error('Unable to load monitored tags'))
    } finally {
      if (monitoredTagsRequestRef.current === controller) {
        monitoredTagsRequestRef.current = null
      }
      if (!controller.signal.aborted) setMonitoredTagsReady(true)
    }
  }, [])

  const refreshCounts = useCallback(async () => {
    const generation = refreshGenerationRef.current
    try {
      const nextCounts = await api.getCounts()
      if (generation !== refreshGenerationRef.current) return
      setCounts(nextCounts)
      setStatusError(null)
    } catch (cause) {
      if (generation !== refreshGenerationRef.current) return
      setStatusError(cause instanceof Error ? cause : new Error('Unable to refresh counts'))
    }
  }, [])

  const refreshDashboard = useCallback(async () => {
    const generation = refreshGenerationRef.current
    try {
      const [nextStatus, nextCounts] = await Promise.all([api.getStatus(), api.getCounts()])
      if (generation !== refreshGenerationRef.current) return
      setStatus(nextStatus)
      setCounts(nextCounts)
      setStatusError(null)
    } catch (cause) {
      if (generation !== refreshGenerationRef.current) return
      setStatusError(cause instanceof Error ? cause : new Error('Dashboard API unavailable'))
    }
  }, [])

  usePolling(refreshDashboard, {
    enabled: status === null || (status.enabled && !status.paused),
    immediate: true,
  })

  usePolling(refreshMonitoredTags, {
    enabled: true,
    immediate: true,
  })

  useEffect(
    () => () => {
      monitoredTagsRequestRef.current?.abort()
    },
    []
  )

  useEffect(() => {
    if (!status?.enabled || status.paused) {
      setLiveUpdateMode('off')
      return
    }
    if (typeof EventSource === 'undefined') {
      setLiveUpdateMode('polling')
      return
    }

    setLiveUpdateMode('connecting')
    const source = new EventSource(api.getStreamUrl())
    source.onopen = () => setLiveUpdateMode('live')
    source.onerror = () => setLiveUpdateMode('polling')
    const receiveFlush = (event: Event) => {
      const parsed = parseFlushStreamEvent((event as MessageEvent<string>).data)
      if (!parsed) return
      setFlushEvent(parsed)
      setFlushRevision((value) => value + 1)
    }
    source.addEventListener('flush', receiveFlush)
    return () => {
      source.onopen = null
      source.onerror = null
      source.removeEventListener('flush', receiveFlush)
      source.close()
    }
  }, [status?.enabled, status?.paused])

  const togglePaused = useCallback(
    async (paused: boolean) => {
      if (!status || mutating) return
      setMutating(true)
      setStatusError(null)
      try {
        if (paused) await api.setFlag('paused')
        else await api.deleteFlag('paused')
        refreshGenerationRef.current += 1
        setStatus((current) => (current ? { ...current, paused } : current))
      } catch (cause) {
        setStatusError(cause instanceof Error ? cause : new Error('Unable to update recording'))
      } finally {
        setMutating(false)
      }
    },
    [mutating, status]
  )

  const clearEntries = useCallback(async () => {
    if (mutating) return
    setMutating(true)
    setStatusError(null)
    try {
      await api.clear()
      refreshGenerationRef.current += 1
      setCounts({})
      setRevision((value) => value + 1)
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause : new Error('Unable to clear entries'))
    } finally {
      setMutating(false)
    }
  }, [mutating])

  const toggleTagMonitoring = useCallback(
    async (value: string) => {
      const tag = value.trim()
      if (!tag || monitoredTagMutationsRef.current.has(tag)) return

      const monitored = monitoredTagsRef.current.includes(tag)
      monitoredTagMutationsRef.current.add(tag)
      monitoredTagMutationGenerationRef.current += 1
      monitoredTagsRequestRef.current?.abort()
      setMonitoringTags((current) => [...current, tag])
      setStatusError(null)
      commitMonitoredTags((current) => setMonitoredTag(current, tag, !monitored))

      try {
        if (monitored) await api.unmonitorTag(tag)
        else await api.monitorTag(tag)
      } catch (cause) {
        commitMonitoredTags((current) => setMonitoredTag(current, tag, monitored))
        setStatusError(
          cause instanceof Error
            ? cause
            : new Error(monitored ? 'Unable to stop monitoring tag' : 'Unable to monitor tag')
        )
      } finally {
        monitoredTagMutationsRef.current.delete(tag)
        setMonitoringTags((current) => current.filter((item) => item !== tag))
      }
    },
    [commitMonitoredTags]
  )

  const contextValue = useMemo(
    () => ({
      status,
      counts,
      statusError,
      mutating,
      revision,
      liveUpdateMode,
      flushEvent,
      flushRevision,
      monitoredTags,
      monitoringTags,
      monitoredTagsReady,
      togglePaused,
      clearEntries,
      refreshCounts,
      toggleTagMonitoring,
    }),
    [
      clearEntries,
      counts,
      flushEvent,
      flushRevision,
      liveUpdateMode,
      monitoredTags,
      monitoringTags,
      monitoredTagsReady,
      mutating,
      refreshCounts,
      revision,
      status,
      statusError,
      togglePaused,
      toggleTagMonitoring,
    ]
  )

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    navigate(globalSearchTarget(String(form.get('tag') ?? '')))
  }

  const pageSegment = location.pathname.split('/').filter(Boolean)[0] ?? 'requests'
  const pageTitle = titleByPath[pageSegment] ?? 'Periscope'
  const searchTag = pageSegment === 'search' ? (searchParams.get('tag') ?? '') : ''

  useEffect(() => {
    activeNavigationRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [location.pathname])

  return (
    <DashboardContext.Provider value={contextValue}>
      <div className="min-h-screen bg-background text-foreground">
        <aside className="border-b bg-muted/55 md:fixed md:inset-y-0 md:left-0 md:z-30 md:flex md:w-60 md:flex-col md:border-b-0 md:border-r">
          <div className="flex h-14 items-center gap-2 px-4 md:h-16">
            <div className="grid size-7 place-items-center rounded-md border bg-background shadow-xs">
              <span className="size-2 rounded-full bg-primary" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold tracking-tight">Periscope</div>
              <div className="text-2xs text-muted-foreground">Runtime recorder</div>
            </div>
            <Badge
              aria-live="polite"
              className="ms-auto"
              role="status"
              size="sm"
              variant={
                liveUpdateMode === 'live'
                  ? 'success'
                  : liveUpdateMode === 'polling'
                    ? 'warning'
                    : 'secondary'
              }
            >
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${
                  liveUpdateMode === 'live'
                    ? 'bg-success'
                    : liveUpdateMode === 'polling'
                      ? 'bg-warning'
                      : 'bg-muted-foreground'
                }`}
              />
              {status ? liveUpdateLabel(liveUpdateMode, status.enabled) : 'Checking updates'}
            </Badge>
          </div>

          <nav
            aria-label="Entry types"
            className="flex gap-1 overflow-x-auto px-2 pb-2 md:min-h-0 md:flex-1 md:flex-col md:overflow-y-auto md:px-3 md:py-3"
          >
            {navigationGroups.map((group) => (
              <div
                aria-label={group.label}
                className="flex shrink-0 gap-1 md:mb-2 md:block md:space-y-1"
                key={group.label}
                role="group"
              >
                <div className="hidden px-3 pb-1 pt-2 text-2xs font-medium text-muted-foreground md:block">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const Icon = item.icon
                  const isCurrent =
                    location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)
                  return (
                    <NavLink
                      className={({ isActive }) =>
                        `flex min-h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                          isActive
                            ? 'bg-background text-foreground shadow-xs'
                            : 'text-muted-foreground hover:bg-accent/55 hover:text-foreground'
                        }`
                      }
                      key={item.to}
                      ref={isCurrent ? activeNavigationRef : undefined}
                      to={item.to}
                    >
                      <Icon aria-hidden="true" className="size-4" />
                      <span>{item.label}</span>
                      <span className="ms-auto font-mono text-xs tabular-nums text-muted-foreground">
                        {(counts[item.type] ?? 0).toLocaleString()}
                      </span>
                    </NavLink>
                  )
                })}
              </div>
            ))}
          </nav>

          <div className="mt-auto hidden border-t p-4 text-xs leading-5 text-muted-foreground md:block">
            Data stays local to this application and follows the recorder retention policy.
          </div>
        </aside>

        <div className="md:pl-60">
          <header className="sticky top-0 z-20 border-b bg-background">
            <div className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-2 sm:px-6 md:min-h-16 lg:px-8">
              <div className="me-auto min-w-28">
                <h1 className="text-base font-semibold tracking-tight">{pageTitle}</h1>
              </div>

              <form
                className="order-last w-full sm:order-none sm:w-72"
                onSubmit={submitSearch}
                role="search"
              >
                <InputGroup>
                  <InputGroupInput
                    aria-label="Search all entries by exact tag"
                    defaultValue={searchTag}
                    key={searchTag}
                    name="tag"
                    placeholder="Search exact tag, e.g. Auth:42"
                    type="search"
                  />
                  <InputGroupAddon>
                    <Search aria-hidden="true" />
                  </InputGroupAddon>
                </InputGroup>
              </form>

              <label className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm font-medium text-muted-foreground">
                <CirclePause aria-hidden="true" className="size-4" />
                <span className="hidden sm:inline">Pause</span>
                <Switch
                  aria-label="Pause recording"
                  checked={status?.paused ?? false}
                  disabled={!status || !status.enabled || mutating}
                  onCheckedChange={(checked) => void togglePaused(checked)}
                />
              </label>

              <AlertDialog>
                <AlertDialogTrigger
                  aria-label="Clear recorded entries"
                  render={<Button disabled={mutating} size="sm" variant="destructive-outline" />}
                >
                  <Trash2 aria-hidden="true" />
                  <span className="hidden sm:inline">Clear</span>
                </AlertDialogTrigger>
                <AlertDialogPopup>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear recorded entries?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently removes every stored entry and cannot be undone. Recording
                      continues unless it is paused separately.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
                    <AlertDialogClose
                      render={<Button loading={mutating} variant="destructive" />}
                      onClick={() => void clearEntries()}
                    >
                      Clear all entries
                    </AlertDialogClose>
                  </AlertDialogFooter>
                </AlertDialogPopup>
              </AlertDialog>
            </div>

            {statusError && (
              <div
                className="flex items-start gap-2 border-t bg-destructive/6 px-4 py-2 text-xs text-destructive-foreground sm:px-6 lg:px-8"
                role="alert"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span>{statusError.message}</span>
              </div>
            )}
          </header>

          <main className="mx-auto w-full max-w-dashboard px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
            <Outlet />
          </main>
        </div>
      </div>
    </DashboardContext.Provider>
  )
}
