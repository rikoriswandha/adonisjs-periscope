import {
  BellRing,
  Bug,
  CirclePause,
  Database,
  CircleHelp,
  Ellipsis,
  Gauge,
  LayoutDashboard,
  Monitor,
  Moon,
  Search,
  Sun,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { DashboardContext } from '@/dashboard-context'
import { usePolling } from '@/hooks/use-polling'
import { api } from '@/lib/api'
import { globalSearchTarget } from '@/lib/global-search'
import { connectLiveUpdates, liveUpdateLabel } from '@/lib/live-updates'
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
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
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
  MenuShortcut,
  MenuTrigger,
} from '@/components/ui/menu'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PeriscopeLogo } from '@/components/periscope-logo'

type NavigationItem = {
  to: string
  label: string
  type?: EntryType
  icon: LucideIcon
}

const navigationGroups: { label: string; items: NavigationItem[] }[] = [
  {
    label: 'Core',
    items: [
      { to: '/overview', label: 'Overview', icon: LayoutDashboard },
      { to: '/requests', label: 'Requests', type: 'request', icon: Gauge },
      { to: '/queries', label: 'Queries', type: 'query', icon: Database },
      { to: '/exceptions', label: 'Exceptions', type: 'exception', icon: Bug },
    ],
  },
  ...(['Application', 'Infrastructure', 'Diagnostics'] as const).map((label) => ({
    label,
    items: [
      ...wave2EntryTypes
        .filter((registration) => registration.group === label)
        .map((registration) => ({
          to: `/${registration.path}`,
          label: registration.label,
          type: registration.type,
          icon: registration.icon,
        })),
      ...(label === 'Diagnostics'
        ? [{ to: '/monitored-tags', label: 'Monitored tags', icon: BellRing }]
        : []),
    ],
  })),
]

const titleByPath: Record<string, string> = {
  'overview': 'Overview',
  'requests': 'Requests',
  'queries': 'Queries',
  'exceptions': 'Exceptions',
  'search': 'Search',
  'monitored-tags': 'Monitored tags',
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

type ThemePreference = 'light' | 'dark' | 'system'

const THEME_STORAGE_KEY = 'periscope-theme'
const ROW_NAVIGATION_EVENT = 'periscope:index-row-navigation'
const CLOSE_DETAIL_EVENT = 'periscope:close-entry-detail'
const themeItems: { label: string; value: ThemePreference }[] = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'System', value: 'system' },
]

const shortcutItems = [
  { keys: ['/'], label: 'Focus search' },
  { keys: ['J'], label: 'Focus next row' },
  { keys: ['K'], label: 'Focus previous row' },
  { keys: ['Esc'], label: 'Close detail drawer' },
  { keys: ['⌘/Ctrl', 'B'], label: 'Toggle sidebar' },
  { keys: ['?'], label: 'Show shortcuts' },
] as const
function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Storage can be unavailable in locked-down browser contexts.
  }
  return 'system'
}

function applyThemePreference(theme: ThemePreference): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.matches('input, textarea, select') ||
    target.isContentEditable ||
    target.closest('[contenteditable="true"]') !== null
  )
}

export function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference)
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
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
    } catch {
      // The in-memory preference still works when persistence is unavailable.
    }
  }, [])

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
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return
      }

      if (event.key === '/') {
        const input = document.querySelector<HTMLInputElement>('form[role="search"] input')
        if (!input) return
        event.preventDefault()
        input.focus()
        input.select()
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
  }, [])

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

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    navigate(globalSearchTarget(String(form.get('text') ?? '')))
  }

  const pageSegment = location.pathname.split('/').filter(Boolean)[0] ?? 'overview'
  const pageTitle = titleByPath[pageSegment] ?? 'Periscope'
  const searchText = pageSegment === 'search' ? (searchParams.get('text') ?? '') : ''
  const applicationSearch = preservedApplication
    ? `?${new URLSearchParams({ application: preservedApplication })}`
    : ''

  return (
    <DashboardContext.Provider value={contextValue}>
      <SidebarProvider className="bg-background text-foreground">
        <Sidebar collapsible="icon" variant="sidebar">
          <SidebarHeader className="gap-2 border-b border-sidebar-border px-2 py-2.5">
            <div className="flex items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
              <PeriscopeLogo className="size-7" />
              <div className="min-w-0 group-data-[collapsible=icon]:hidden">
                <div className="truncate text-sm font-semibold tracking-tight">Periscope</div>
                <div className="truncate text-2xs text-muted-foreground">
                  Local runtime recorder
                </div>
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
                        location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)
                      const count = item.type ? (counts[item.type] ?? 0) : null
                      return (
                        <SidebarMenuItem key={item.to}>
                          <SidebarMenuButton
                            isActive={isActive}
                            render={
                              <NavLink to={{ pathname: item.to, search: applicationSearch }} />
                            }
                            size="sm"
                            tooltip={item.label}
                          >
                            <Icon aria-hidden="true" />
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                          {count !== null && (
                            <SidebarMenuBadge className="font-mono text-2xs text-muted-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground">
                              {count.toLocaleString()}
                            </SidebarMenuBadge>
                          )}
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
              <div className="me-auto flex min-w-0 items-center gap-2">
                <h1 className="truncate text-sm font-semibold tracking-tight">{pageTitle}</h1>
                {status?.paused && (
                  <Badge
                    render={
                      <button
                        aria-label="Recording paused. Resume recording"
                        disabled={mutating}
                        onClick={() => void togglePaused(false)}
                        type="button"
                      />
                    }
                    variant="warning"
                  >
                    <CirclePause aria-hidden="true" />
                    Paused
                  </Badge>
                )}
              </div>

              <form
                className="order-last w-full basis-full sm:order-none sm:w-64 sm:basis-auto"
                onSubmit={submitSearch}
                role="search"
              >
                <InputGroup>
                  <InputGroupInput
                    aria-label="Search all recorded entry content"
                    className="text-xs"
                    defaultValue={searchText}
                    key={searchText}
                    name="text"
                    placeholder="Search recorded content"
                    type="search"
                  />
                  <InputGroupAddon>
                    <Search aria-hidden="true" />
                  </InputGroupAddon>
                </InputGroup>
              </form>

              {(status?.applications.length ?? 0) > 1 && (
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
                    className="max-w-[38vw] sm:w-36"
                    size="sm"
                  >
                    <Database aria-hidden="true" />
                    <SelectValue placeholder="Application" />
                  </SelectTrigger>
                  <SelectPopup>
                    {(status?.applications ?? []).map((application) => (
                      <SelectItem key={application.name} value={application.name}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">{application.name}</span>
                          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                            {application.entries.toLocaleString()}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              )}

              <div className="relative shrink-0">
                <Menu>
                  <MenuTrigger
                    render={<Button aria-label="Dashboard options" size="sm" variant="ghost" />}
                  >
                    <Ellipsis aria-hidden="true" />
                  </MenuTrigger>
                  <MenuPopup align="end" className="w-52">
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
                      <MenuGroupLabel>Theme</MenuGroupLabel>
                      <MenuRadioGroup
                        onValueChange={(value) => {
                          if (value === 'light' || value === 'dark' || value === 'system') {
                            selectTheme(value)
                          }
                        }}
                        value={theme}
                      >
                        {themeItems.map((item) => {
                          const Icon =
                            item.value === 'light' ? Sun : item.value === 'dark' ? Moon : Monitor
                          return (
                            <MenuRadioItem key={item.value} value={item.value}>
                              <span className="flex items-center gap-2">
                                <Icon aria-hidden="true" />
                                {item.label}
                              </span>
                            </MenuRadioItem>
                          )
                        })}
                      </MenuRadioGroup>
                    </MenuGroup>
                    <MenuSeparator />
                    <MenuItem onClick={() => setShortcutHelpOpen(true)}>
                      <CircleHelp aria-hidden="true" />
                      Keyboard shortcuts
                      <MenuShortcut>?</MenuShortcut>
                    </MenuItem>
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
                <Dialog onOpenChange={setShortcutHelpOpen} open={shortcutHelpOpen}>
                  <DialogPopup
                    aria-modal="true"
                    bottomStickOnMobile={false}
                    className="w-64 rounded-lg p-3"
                    id="keyboard-shortcut-help"
                    showCloseButton={false}
                  >
                    <DialogTitle className="mb-2 text-xs">Keyboard shortcuts</DialogTitle>
                    <DialogPanel className="p-0" scrollFade={false}>
                      <dl className="space-y-1.5">
                        {shortcutItems.map((shortcut) => (
                          <div
                            className="flex items-center justify-between gap-4"
                            key={shortcut.label}
                          >
                            <dt className="text-xs text-muted-foreground">{shortcut.label}</dt>
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
              </div>

              <AlertDialog onOpenChange={setClearDialogOpen} open={clearDialogOpen}>
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
