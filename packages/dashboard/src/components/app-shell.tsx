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
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Switch } from '@/components/ui/switch'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PeriscopeLogo } from '@/components/periscope-logo'

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
  ...(['Application', 'Infrastructure', 'Diagnostics'] as const).map((label) => ({
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

function LiveStatusBadge({
  liveUpdateMode,
  enabled,
}: {
  liveUpdateMode: LiveUpdateMode
  enabled: boolean | undefined
}) {
  const variant =
    liveUpdateMode === 'live' ? 'success' : liveUpdateMode === 'polling' ? 'warning' : 'secondary'

  return (
    <Badge
      aria-live="polite"
      className="font-mono tabular-nums"
      role="status"
      size="sm"
      variant={variant}
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
      {enabled === undefined ? 'Checking' : liveUpdateLabel(liveUpdateMode, enabled)}
    </Badge>
  )
}

export function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
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
  const requestedApplication = searchParams.get('application')
  const selectedApplication = useMemo(() => {
    if (
      requestedApplication &&
      status?.applications.some((application) => application.name === requestedApplication)
    ) {
      return requestedApplication
    }
    return status?.applicationName ?? requestedApplication ?? 'default'
  }, [requestedApplication, status])
  const selectApplication = useCallback(
    (application: string) => {
      const next = new URLSearchParams(searchParams)
      next.set('application', application)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams]
  )

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
      const nextCounts = await api.getCounts(selectedApplication)
      if (generation !== refreshGenerationRef.current) return
      setCounts(nextCounts)
      setStatusError(null)
    } catch (cause) {
      if (generation !== refreshGenerationRef.current) return
      setStatusError(cause instanceof Error ? cause : new Error('Unable to refresh counts'))
    }
  }, [selectedApplication])

  const refreshDashboard = useCallback(async () => {
    const generation = refreshGenerationRef.current
    try {
      const nextStatus = await api.getStatus()
      const application =
        requestedApplication &&
        nextStatus.applications.some((item) => item.name === requestedApplication)
          ? requestedApplication
          : nextStatus.applicationName
      const nextCounts = await api.getCounts(application)
      if (generation !== refreshGenerationRef.current) return
      setStatus(nextStatus)
      setCounts(nextCounts)
      setStatusError(null)
    } catch (cause) {
      if (generation !== refreshGenerationRef.current) return
      setStatusError(cause instanceof Error ? cause : new Error('Dashboard API unavailable'))
    }
  }, [requestedApplication])

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
      if (parsed.indexRow.application !== selectedApplication) return
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
  }, [selectedApplication, status?.enabled, status?.paused])

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
      await api.clear(selectedApplication)
      refreshGenerationRef.current += 1
      setCounts({})
      setRevision((value) => value + 1)
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause : new Error('Unable to clear entries'))
    } finally {
      setMutating(false)
    }
  }, [mutating, selectedApplication])

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
      selectedApplication,
      selectApplication,
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
      selectApplication,
      selectedApplication,
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

  return (
    <DashboardContext.Provider value={contextValue}>
      <SidebarProvider className="bg-background text-foreground">
        <Sidebar collapsible="icon" variant="sidebar">
          <SidebarHeader className="gap-2 border-b border-sidebar-border px-2 py-2.5">
            <div className="flex items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
              <PeriscopeLogo className="size-7" />
              <div className="min-w-0 group-data-[collapsible=icon]:hidden">
                <div className="truncate text-sm font-semibold tracking-tight">Periscope</div>
                <div className="truncate text-2xs text-muted-foreground">Local runtime recorder</div>
              </div>
            </div>
            <div className="px-1 group-data-[collapsible=icon]:hidden">
              <LiveStatusBadge liveUpdateMode={liveUpdateMode} enabled={status?.enabled} />
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-1 px-1 py-2">
            {navigationGroups.map((group, index) => (
              <SidebarGroup className="p-1" key={group.label}>
                {index > 0 && <SidebarSeparator className="mx-1 mb-2" />}
                <SidebarGroupLabel className="h-6 px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  {group.label}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => {
                      const Icon = item.icon
                      const isActive =
                        location.pathname === item.to ||
                        location.pathname.startsWith(`${item.to}/`)
                      const count = counts[item.type] ?? 0
                      return (
                        <SidebarMenuItem key={item.to}>
                          <SidebarMenuButton
                            isActive={isActive}
                            render={<NavLink to={item.to} />}
                            size="sm"
                            tooltip={item.label}
                          >
                            <Icon aria-hidden="true" />
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                          <SidebarMenuBadge className="font-mono text-2xs text-muted-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground">
                            {count.toLocaleString()}
                          </SidebarMenuBadge>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>

          <SidebarFooter className="gap-2 border-t border-sidebar-border p-2">
            <p className="px-2 text-2xs leading-4 text-muted-foreground group-data-[collapsible=icon]:hidden">
              Entries stay in this app&apos;s local store and follow retention settings.
            </p>
            <div className="flex items-center gap-1.5 px-2 text-2xs text-muted-foreground group-data-[collapsible=icon]:hidden">
              <span>Toggle nav</span>
              <KbdGroup>
                <Kbd>⌘</Kbd>
                <Kbd>B</Kbd>
              </KbdGroup>
            </div>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>

        <SidebarInset>
          <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur-sm supports-backdrop-filter:bg-background/80">
            <div className="flex min-h-12 flex-wrap items-center gap-2 px-3 py-2 sm:px-4 lg:px-5">
              <SidebarTrigger className="-ms-1" />
              <Separator className="mx-0.5 hidden h-4 sm:block" orientation="vertical" />
              <div className="me-auto min-w-0">
                <h1 className="truncate text-sm font-semibold tracking-tight">{pageTitle}</h1>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <label className="flex min-h-8 items-center gap-2 rounded-md px-1.5 text-xs font-medium text-muted-foreground">
                  <CirclePause aria-hidden="true" className="size-3.5" />
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
                        This permanently removes entries recorded by “{selectedApplication}” and
                        cannot be undone. Other applications in this shared store are not changed.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
                      <AlertDialogClose
                        render={<Button loading={mutating} variant="destructive" />}
                        onClick={() => void clearEntries()}
                      >
                        Clear {selectedApplication}
                      </AlertDialogClose>
                    </AlertDialogFooter>
                  </AlertDialogPopup>
                </AlertDialog>
              </div>

              <Select
                items={(status?.applications ?? []).map((application) => ({
                  label: application.name,
                  value: application.name,
                }))}
                onValueChange={(value) => {
                  if (typeof value === 'string' && value !== '') selectApplication(value)
                }}
                value={selectedApplication}
              >
                <SelectTrigger
                  aria-label="Application"
                  className="max-w-[46vw] sm:w-40"
                  size="sm"
                >
                  <Database aria-hidden="true" />
                  <SelectValue placeholder="Application" />
                </SelectTrigger>
                <SelectPopup>
                  {(status?.applications ?? []).map((application) => (
                    <SelectItem key={application.name} value={application.name}>
                      <span className="min-w-0 flex-1 truncate">{application.name}</span>
                      <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                        {application.entries.toLocaleString()}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>

              <form
                className="order-last w-full basis-full sm:order-none sm:w-64 sm:basis-auto"
                onSubmit={submitSearch}
                role="search"
              >
                <InputGroup>
                  <InputGroupInput
                    aria-label="Search all entries by exact tag"
                    className="font-mono text-xs"
                    defaultValue={searchTag}
                    key={searchTag}
                    name="tag"
                    placeholder="Exact tag, e.g. Auth:42"
                    type="search"
                  />
                  <InputGroupAddon>
                    <Search aria-hidden="true" />
                  </InputGroupAddon>
                </InputGroup>
              </form>
            </div>

            {statusError && (
              <div
                className="flex items-start gap-2 border-t bg-destructive/6 px-3 py-2 text-xs text-destructive-foreground sm:px-4 lg:px-5"
                role="alert"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span>{statusError.message}</span>
              </div>
            )}
          </header>

          <main className="mx-auto w-full max-w-dashboard flex-1 px-3 py-4 sm:px-4 sm:py-5 lg:px-5">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </DashboardContext.Provider>
  )
}
