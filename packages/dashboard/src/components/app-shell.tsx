import {
  Box,
  Braces,
  Bug,
  CirclePause,
  Database,
  DatabaseZap,
  Gauge,
  Globe2,
  Mail,
  Search,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { DashboardContext } from '@/dashboard-context'
import { usePolling } from '@/hooks/use-polling'
import { api } from '@/lib/api'
import type { DashboardStatus, EntryCounts } from '@/types'
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

const navigationGroups = [
  {
    label: 'Core',
    items: [
      { to: '/requests', label: 'Requests', type: 'request', icon: Gauge },
      { to: '/queries', label: 'Queries', type: 'query', icon: Database },
      { to: '/exceptions', label: 'Exceptions', type: 'exception', icon: Bug },
    ],
  },
  {
    label: 'Application',
    items: [
      { to: '/commands', label: 'Commands', type: 'command', icon: SquareTerminal },
      { to: '/mail', label: 'Mail', type: 'mail', icon: Mail },
      { to: '/cache', label: 'Cache', type: 'cache', icon: DatabaseZap },
      { to: '/models', label: 'Models', type: 'model', icon: Box },
      { to: '/gates', label: 'Gates', type: 'gate', icon: ShieldCheck },
    ],
  },
  {
    label: 'Diagnostics',
    items: [
      { to: '/dumps', label: 'Dumps', type: 'dump', icon: Braces },
      { to: '/http-client', label: 'HTTP client', type: 'http_client', icon: Globe2 },
    ],
  },
] as const

const titleByPath: Record<string, string> = {
  'requests': 'Requests',
  'queries': 'Queries',
  'exceptions': 'Exceptions',
  'commands': 'Commands',
  'mail': 'Mail',
  'cache': 'Cache',
  'models': 'Models',
  'gates': 'Gates',
  'dumps': 'Dumps',
  'http-client': 'HTTP client',
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
  const refreshGenerationRef = useRef(0)
  const activeNavigationRef = useRef<HTMLAnchorElement>(null)

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

  const contextValue = useMemo(
    () => ({
      status,
      counts,
      statusError,
      mutating,
      revision,
      togglePaused,
      clearEntries,
      refreshCounts,
    }),
    [clearEntries, counts, mutating, refreshCounts, revision, status, statusError, togglePaused]
  )

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const next = new URLSearchParams(searchParams)
    const form = new FormData(event.currentTarget)
    const tag = String(form.get('tag') ?? '').trim()
    if (tag) next.set('tag', tag)
    else next.delete('tag')
    const target = `/${pageSegment}${next.size ? `?${next.toString()}` : ''}`
    if (location.pathname === `/${pageSegment}`) setSearchParams(next, { replace: true })
    else navigate(target, { replace: true })
  }

  const pageSegment = location.pathname.split('/').filter(Boolean)[0] ?? 'requests'
  const pageTitle = titleByPath[pageSegment] ?? 'Periscope'

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
            <Badge className="ms-auto" size="sm" variant={status?.paused ? 'warning' : 'secondary'}>
              {!status
                ? 'checking'
                : status.paused
                  ? 'paused'
                  : status.enabled
                    ? 'live'
                    : 'offline'}
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
                      to={`${item.to}${searchParams.get('tag') ? `?tag=${encodeURIComponent(searchParams.get('tag')!)}` : ''}`}
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
                    aria-label="Filter by exact tag"
                    defaultValue={searchParams.get('tag') ?? ''}
                    key={searchParams.get('tag') ?? ''}
                    name="tag"
                    placeholder="Exact tag, e.g. status:500"
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
