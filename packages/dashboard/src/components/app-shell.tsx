import {
  CirclePause,
  Database,
  Ellipsis,
  Menu as MenuIcon,
  PanelLeft,
  Rows2,
  Rows3,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom'

import { CommandPalette } from '@/components/command-palette'
import { PeriscopeLogo } from '@/components/periscope-logo'
import { SignalStrip } from '@/components/signal-strip'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetPopup, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { DashboardContext } from '@/dashboard-context'
import { usePolling } from '@/hooks/use-polling'
import { api } from '@/lib/api'
import { connectLiveUpdates, liveUpdateLabel } from '@/lib/live-updates'
import { normalizeMonitoredTags, setMonitoredTag } from '@/lib/monitored-tags'
import { navigationGroups, titleByPath } from '@/lib/navigation'
import type { Density, ThemePreference } from '@/lib/preferences'
import {
  applyDensity,
  applyThemePreference,
  readDensity,
  readThemePreference,
} from '@/lib/preferences'
import { cn } from '@/lib/utils'
import type {
  DashboardStatus,
  EntryCounts,
  FlushStreamEvent,
  LiveUpdateMode,

} from '@/types'

const ROW_NAVIGATION_EVENT = 'periscope:index-row-navigation'
const CLOSE_DETAIL_EVENT = 'periscope:close-entry-detail'
const RAIL_STORAGE_KEY = 'periscope-rail-collapsed'

const shortcutItems = [
  { label: 'Command palette', keys: ['⌘', 'K'] },
  { label: 'Search recorded content', keys: ['/'] },
  { label: 'Collapse navigation', keys: ['⌘', 'B'] },
  { label: 'Move between rows', keys: ['J', 'K'] },
  { label: 'Close detail', keys: ['Esc'] },
  { label: 'This help', keys: ['?'] },
] as const

const densityItems: { label: string; value: Density }[] = [
  { label: 'Compact', value: 'compact' },
  { label: 'Comfortable', value: 'comfortable' },
]

const themeItems: { label: string; value: ThemePreference }[] = [
  { label: 'Dark', value: 'dark' },
  { label: 'Light', value: 'light' },
  { label: 'System', value: 'system' },
]

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
  )
}

/**
 * The live indicator. A recorder's most important piece of status is whether it
 * is currently recording, so it sits in the rail header where it is never more
 * than a glance away.
 */
function LiveIndicator({
  liveUpdateMode,
  enabled,
  compact,
}: {
  liveUpdateMode: LiveUpdateMode
  enabled: boolean | undefined
  compact: boolean
}) {
  const live = liveUpdateMode === 'live'
  const connecting = liveUpdateMode === 'connecting'
  const tone = enabled === false || liveUpdateMode === 'off' ? 'off' : live ? 'live' : 'degraded'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-micro',
        tone === 'live' && 'text-sig-ok',
        tone === 'degraded' && 'text-sig-warn',
        tone === 'off' && 'text-ink-4'
      )}
      title={liveUpdateLabel(liveUpdateMode, enabled ?? false)}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-[5px] shrink-0 rounded-full',
          tone === 'live' && 'bg-sig-ok',
          tone === 'degraded' && 'bg-sig-warn',
          tone === 'off' && 'bg-ink-4',
          (live || connecting) && 'animate-pulse-dot'
        )}
      />
      {!compact && (
        <span className="truncate">{liveUpdateLabel(liveUpdateMode, enabled ?? false)}</span>
      )}
    </span>
  )
}

/**
 * The navigation rail. Built directly rather than through a generic sidebar
 * primitive: the chassis *is* the identity here, and the active state is a
 * raised panel rather than a coloured stripe.
 */
function Rail({
  collapsed,
  counts,
  applicationSearch,
  onNavigate,
}: {
  collapsed: boolean
  counts: EntryCounts
  applicationSearch: string
  onNavigate?: () => void
}) {
  const location = useLocation()

  return (
    <nav
      aria-label="Watchers"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 py-3"
    >
      {navigationGroups.map((group) => (
        <div className="flex flex-col gap-0.5" key={group.label}>
          {!collapsed && <span className="micro-label px-2 pb-1">{group.label}</span>}
          {group.items.map((item) => {
            const Icon = item.icon
            const active =
              location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)
            const count = item.type ? (counts[item.type] ?? 0) : null

            const link = (
              <NavLink
                aria-label={collapsed ? item.label : undefined}
                className={cn(
                  'group relative flex h-7 shrink-0 items-center gap-2 rounded-sm px-2',
                  'transition-colors duration-(--dur-fast) ease-(--ease-out-quart)',
                  collapsed && 'justify-center px-0',
                  active
                    ? 'border border-edge-strong bg-panel-raised text-ink shadow-[inset_0_1px_0_0_var(--highlight)]'
                    : 'border border-transparent text-ink-2 hover:bg-panel hover:text-ink'
                )}
                onClick={onNavigate}
                key={item.to}
                to={{ pathname: item.to, search: applicationSearch }}
              >
                <Icon
                  aria-hidden="true"
                  className={cn('size-3.5 shrink-0', active ? 'text-ink' : 'text-ink-3')}
                />
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                    {count !== null && (
                      <span
                        className={cn(
                          'num shrink-0 text-micro',
                          count === 0 ? 'text-ink-4' : active ? 'text-ink-2' : 'text-ink-3'
                        )}
                      >
                        {count.toLocaleString()}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            )

            if (!collapsed) return link

            return (
              <Tooltip key={item.to}>
                <TooltipTrigger render={link} />
                <TooltipPopup side="right">
                  <span className="flex items-center gap-2">
                    {item.label}
                    {count !== null && <span className="num text-ink-3">{count}</span>}
                  </span>
                </TooltipPopup>
              </Tooltip>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

export function AppShell() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference)
  const [density, setDensity] = useState<Density>(readDensity)
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
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
  const preservedApplicationRef = useRef<string | null>(searchParams.get('application'))

  const commitMonitoredTags = useCallback((update: (current: string[]) => string[]) => {
    const next = update(monitoredTagsRef.current)
    monitoredTagsRef.current = next
    setMonitoredTags(next)
  }, [])

  const requestedApplication = searchParams.get('application')
  if (requestedApplication) preservedApplicationRef.current = requestedApplication
  const preservedApplication = requestedApplication ?? preservedApplicationRef.current

  const selectedApplication = useMemo(() => {
    if (
      preservedApplication &&
      status?.applications.some((application) => application.name === preservedApplication)
    ) {
      return preservedApplication
    }
    return status?.applicationName ?? preservedApplication ?? 'default'
  }, [preservedApplication, status])

  const selectApplication = useCallback(
    (application: string) => {
      const next = new URLSearchParams(searchParams)
      next.set('application', application)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  const selectTheme = useCallback((nextTheme: ThemePreference) => {
    setTheme(nextTheme)
    applyThemePreference(nextTheme)
  }, [])

  const selectDensity = useCallback((nextDensity: Density) => {
    setDensity(nextDensity)
    applyDensity(nextDensity)
  }, [])

  const toggleRail = useCallback(() => {
    setRailCollapsed((collapsed) => {
      const next = !collapsed
      try {
        localStorage.setItem(RAIL_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // The in-memory preference still works when persistence is unavailable.
      }
      return next
    })
  }, [])

  useEffect(() => {
    applyDensity(density)
  }, [density])

  useEffect(() => {
    applyThemePreference(theme)
    if (theme !== 'system') return

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const syncSystemTheme = () => applyThemePreference('system')
    media.addEventListener('change', syncSystemTheme)
    return () => media.removeEventListener('change', syncSystemTheme)
  }, [theme])

  useEffect(() => {
    if (requestedApplication || !preservedApplication) return

    const next = new URLSearchParams(searchParams)
    next.set('application', preservedApplication)
    setSearchParams(next, { replace: true })
  }, [preservedApplication, requestedApplication, searchParams, setSearchParams])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        toggleRail()
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return

      if (event.key === '/') {
        event.preventDefault()
        setPaletteOpen(true)
        return
      }

      if (event.key === '?') {
        event.preventDefault()
        setShortcutHelpOpen((open) => !open)
        return
      }

      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault()
        window.dispatchEvent(
          new CustomEvent(ROW_NAVIGATION_EVENT, {
            detail: { direction: event.key === 'j' ? 1 : -1 },
          })
        )
        return
      }

      if (event.key === 'Escape') {
        window.dispatchEvent(new Event(CLOSE_DETAIL_EVENT))
      }
    }

    window.addEventListener('keydown', handleShortcut, true)
    return () => window.removeEventListener('keydown', handleShortcut, true)
  }, [toggleRail])

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

  usePolling(refreshMonitoredTags, { enabled: true, immediate: true })

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
    const connection = connectLiveUpdates({
      url: api.getStreamUrl(selectedApplication),
      onModeChange: setLiveUpdateMode,
      onFlush: (event) => {
        if (event.indexRow.application !== selectedApplication) return
        setFlushEvent(event)
        setFlushRevision((value) => value + 1)
      },
    })
    return () => connection.close()
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

  const pageSegment = location.pathname.split('/').filter(Boolean)[0] ?? 'overview'
  const pageTitle = titleByPath[pageSegment] ?? 'Periscope'
  const sectionLabel =
    navigationGroups.find((group) => group.items.some((item) => item.to === `/${pageSegment}`))
      ?.label ?? 'Core'
  const applicationSearch = preservedApplication
    ? `?${new URLSearchParams({ application: preservedApplication })}`
    : ''
  const applications = status?.applications ?? []

  const railBrand = (
    <div
      className={cn(
        'flex h-11 shrink-0 items-center gap-2 border-b border-edge px-3',
        railCollapsed && 'justify-center px-0'
      )}
    >
      <PeriscopeLogo className="size-5" />
      {!railCollapsed && (
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm leading-4 font-semibold tracking-tight text-ink">
            Periscope
          </span>
          <LiveIndicator
            compact={false}
            enabled={status?.enabled}
            liveUpdateMode={liveUpdateMode}
          />
        </div>
      )}
    </div>
  )

  const railFooter = !railCollapsed && (
    <div className="flex shrink-0 flex-col gap-2 border-t border-edge p-2">
      {applications.length > 1 ? (
        <Select
          items={applications.map((application) => ({
            label: application.name,
            value: application.name,
          }))}
          onValueChange={(value) => {
            if (typeof value === 'string' && value !== '') selectApplication(value)
          }}
          value={selectedApplication}
        >
          <SelectTrigger aria-label="Recording application" className="w-full" size="sm">
            <Database aria-hidden="true" />
            <SelectValue placeholder="Application" />
          </SelectTrigger>
          <SelectPopup>
            {applications.map((application) => (
              <SelectItem key={application.name} value={application.name}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{application.name}</span>
                  <span className="num text-micro text-ink-3">
                    {application.entries.toLocaleString()}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <span className="num truncate px-1 text-micro text-ink-4" title={selectedApplication}>
          {selectedApplication}
        </span>
      )}
      <p className="px-1 text-micro leading-4 text-ink-4">
        Entries stay in this app&apos;s local store and follow retention settings.
      </p>
    </div>
  )

  return (
    <DashboardContext.Provider value={contextValue}>
      <div className="flex h-dvh overflow-hidden bg-chassis text-ink">
        <aside
          className={cn(
            'relative hidden shrink-0 flex-col border-r border-edge bg-[var(--sidebar)] lg:flex',
            'transition-[width] duration-(--dur-base) ease-(--ease-out-quart)',
            railCollapsed ? 'w-[3.25rem]' : 'w-56',
            'z-[var(--z-rail)]'
          )}
        >
          {railBrand}
          <Rail
            applicationSearch={applicationSearch}
            collapsed={railCollapsed}
            counts={counts}
          />
          {railFooter}
        </aside>

        <Sheet onOpenChange={setMobileNavOpen} open={mobileNavOpen}>
          <SheetPopup
            className="flex w-64 flex-col bg-[var(--sidebar)] p-0"
            side="left"
          >
            <SheetTitle className="sr-only">Watchers</SheetTitle>
            {railBrand}
            <Rail
              applicationSearch={applicationSearch}
              collapsed={false}
              counts={counts}
              onNavigate={() => setMobileNavOpen(false)}
            />
            {railFooter}
          </SheetPopup>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className="z-[var(--z-sticky)] flex h-11 shrink-0 items-center gap-2 border-b border-edge bg-chassis px-3"
          >
            <Button
              aria-label="Open navigation"
              className="lg:hidden"
              onClick={() => setMobileNavOpen(true)}
              size="sm"
              variant="ghost"
            >
              <MenuIcon aria-hidden="true" />
            </Button>
            <Button
              aria-label={railCollapsed ? 'Expand navigation' : 'Collapse navigation'}
              className="hidden lg:inline-flex"
              onClick={toggleRail}
              size="sm"
              variant="ghost"
            >
              <PanelLeft aria-hidden="true" />
            </Button>

            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
              <span className="hidden text-sm text-ink-4 sm:inline">{sectionLabel}</span>
              <span aria-hidden="true" className="hidden text-ink-4 sm:inline">
                /
              </span>
              <h1 className="truncate text-sm font-medium text-ink" aria-current="page">
                {pageTitle}
              </h1>
            </nav>

            {status?.paused && (
              <button
                aria-label="Recording paused. Resume recording"
                className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-sm border border-sig-warn/35 bg-sig-warn/10 px-1.5 text-micro text-sig-warn transition-colors hover:bg-sig-warn/16"
                disabled={mutating}
                onClick={() => void togglePaused(false)}
                type="button"
              >
                <CirclePause aria-hidden="true" className="size-3" />
                Paused
              </button>
            )}

            <div className="ms-auto flex shrink-0 items-center gap-1.5">
              <button
                aria-label="Open command palette"
                className={cn(
                  'group flex h-7 items-center gap-2 rounded-sm border border-edge bg-well px-2',
                  'text-ink-3 transition-colors duration-(--dur-fast) ease-(--ease-out-quart)',
                  'hover:border-edge-strong hover:text-ink-2'
                )}
                onClick={() => setPaletteOpen(true)}
                type="button"
              >
                <Search aria-hidden="true" className="size-3.5" />
                <span className="hidden text-sm md:inline">Search or jump to…</span>
                <KbdGroup className="hidden md:flex">
                  <Kbd>⌘</Kbd>
                  <Kbd>K</Kbd>
                </KbdGroup>
              </button>

              <span className="hidden lg:inline">
                <LiveIndicator
                  compact
                  enabled={status?.enabled}
                  liveUpdateMode={liveUpdateMode}
                />
              </span>

              <Menu>
                <MenuTrigger
                  render={<Button aria-label="Dashboard options" size="sm" variant="ghost" />}
                >
                  <Ellipsis aria-hidden="true" />
                </MenuTrigger>
                <MenuPopup align="end" className="w-56">
                  <MenuCheckboxItem
                    checked={status?.paused ?? false}
                    disabled={!status || !status.enabled || mutating}
                    onCheckedChange={(checked) => void togglePaused(checked)}
                    variant="switch"
                  >
                    <span className="flex items-center gap-2">
                      <CirclePause aria-hidden="true" />
                      Pause recording
                    </span>
                  </MenuCheckboxItem>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Density</MenuGroupLabel>
                    <MenuRadioGroup
                      onValueChange={(value) => {
                        if (value === 'compact' || value === 'comfortable') selectDensity(value)
                      }}
                      value={density}
                    >
                      {densityItems.map((item) => (
                        <MenuRadioItem key={item.value} value={item.value}>
                          <span className="flex items-center gap-2">
                            {item.value === 'compact' ? (
                              <Rows3 aria-hidden="true" />
                            ) : (
                              <Rows2 aria-hidden="true" />
                            )}
                            {item.label}
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Theme</MenuGroupLabel>
                    <MenuRadioGroup
                      onValueChange={(value) => {
                        if (value === 'light' || value === 'dark' || value === 'system') {
                          selectTheme(value)
                        }
                      }}
                      value={theme}
                    >
                      {themeItems.map((item) => (
                        <MenuRadioItem key={item.value} value={item.value}>
                          {item.label}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuItem
                    disabled={mutating}
                    onClick={() => setClearDialogOpen(true)}
                    variant="destructive"
                  >
                    <Trash2 aria-hidden="true" />
                    Clear entries…
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          </header>

          <SignalStrip />

          {statusError && (
            <div
              className="flex shrink-0 items-start gap-2 border-b border-sig-error/30 bg-sig-error/8 px-3 py-1.5 text-xs text-sig-error"
              role="alert"
            >
              <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              <span>{statusError.message}</span>
            </div>
          )}

          <main className="min-h-0 flex-1 overflow-y-auto bg-chassis px-4 py-4">
            <Outlet />
          </main>
        </div>
      </div>

      <CommandPalette
        density={density}
        onClearRequest={() => setClearDialogOpen(true)}
        onDensityChange={selectDensity}
        onOpenChange={setPaletteOpen}
        onShortcutHelp={() => setShortcutHelpOpen(true)}
        onThemeChange={selectTheme}
        open={paletteOpen}
        theme={theme}
      />

      <Dialog onOpenChange={setShortcutHelpOpen} open={shortcutHelpOpen}>
        <DialogPopup
          aria-modal="true"
          bottomStickOnMobile={false}
          className="w-72 p-3"
          showCloseButton={false}
        >
          <DialogTitle className="mb-2 text-sm">Keyboard shortcuts</DialogTitle>
          <DialogPanel className="p-0" scrollFade={false}>
            <dl className="space-y-1.5">
              {shortcutItems.map((shortcut) => (
                <div className="flex items-center justify-between gap-4" key={shortcut.label}>
                  <dt className="text-sm text-ink-3">{shortcut.label}</dt>
                  <dd>
                    <KbdGroup>
                      {shortcut.keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </KbdGroup>
                  </dd>
                </div>
              ))}
            </dl>
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <AlertDialog onOpenChange={setClearDialogOpen} open={clearDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear recorded entries?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes entries recorded by “{selectedApplication}” and cannot be
              undone. Other applications in this shared store are not changed.
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
    </DashboardContext.Provider>
  )
}
