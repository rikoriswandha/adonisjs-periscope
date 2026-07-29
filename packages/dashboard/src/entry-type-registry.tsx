import { Route } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'

import { EntryDetailDrawer, EntryDetailScope } from '@/components/entry-detail-drawer'
import type { EntryDetailPresentation } from '@/components/entry-detail-drawer'
import { EntryFilterBar } from '@/components/entry-filter-bar'
import { EntryIndexTable } from '@/components/entry-index-table'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { PageHeader } from '@/components/page-header'
import { TagChip } from '@/components/tag-chip'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useDashboard } from '@/dashboard-context'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { formatDateTime } from '@/lib/format'
import { entryUrlFilterState } from '@/lib/global-search'
import { registerEntryType as registerMetadata } from '@/lib/entry-type-registration'
import type { EntryFilters, EntryType, StoredEntry } from '@/types'

const ROW_NAVIGATION_EVENT = 'periscope:index-row-navigation'
const CLOSE_DETAIL_EVENT = 'periscope:close-entry-detail'

export type RegisteredEntryDetailProps = {
  entry: StoredEntry
  open: boolean
  onClose: () => void
}
export type RegisteredEntryDetailComponent = ComponentType<RegisteredEntryDetailProps>

export type EntryTypeImplementation = {
  heading: string
  description: string
  caption: string
  columns: EntryColumn[]
  emptyTitle: (tag?: string) => string
  emptyDescription: (tag?: string) => string
  rowLabel: (entry: StoredEntry) => string
  detailComponent: ComponentType<RegisteredEntryDetailProps>
  pageEffect?: ComponentType
  overviewComponent?: ComponentType<{ entries: StoredEntry[] }>
}

export type EntryTypeRegistration = {
  type: EntryType
  path: string
  label: string
  group: 'Application' | 'Infrastructure' | 'Diagnostics'
  icon: LucideIcon
  load: () => Promise<EntryTypeImplementation>
}

type EntryDetailLoader = () => Promise<RegisteredEntryDetailComponent>

const registrationsByType = new Map<EntryType, EntryTypeRegistration>()
const detailLoads = new Map<EntryType, Promise<RegisteredEntryDetailComponent>>()
const coreDetailLoaders: Partial<Record<EntryType, EntryDetailLoader>> = {
  request: () =>
    import('@/pages/request-batch-page').then((module) => module.RequestEntryDetail),
  query: () => import('@/pages/queries-page').then((module) => module.QueryEntryDetail),
  exception: () =>
    import('@/pages/exceptions-page').then((module) => module.ExceptionEntryDetail),
}

export function getEntryTypeRegistration(type: EntryType): EntryTypeRegistration | undefined {
  return registrationsByType.get(type)
}

export function loadEntryDetailComponent(
  type: EntryType
): Promise<RegisteredEntryDetailComponent> {
  const pending = detailLoads.get(type)
  if (pending) return pending

  const coreLoader = coreDetailLoaders[type]
  const registration = registrationsByType.get(type)
  const load =
    coreLoader ??
    (registration
      ? () => registration.load().then((implementation) => implementation.detailComponent)
      : undefined)

  if (!load) {
    return Promise.reject(new Error(`No detail renderer is registered for ${type}`))
  }

  const next = load().catch((cause: unknown) => {
    detailLoads.delete(type)
    throw cause
  })
  detailLoads.set(type, next)
  return next
}

function GenericEntryDetail({
  entry,
  open,
  onClose,
  error,
}: RegisteredEntryDetailProps & { error?: Error }) {
  return (
    <EntryDetailDrawer
      description={`${entry.type.replaceAll('_', ' ')} · ${formatDateTime(entry.createdAt)}`}
      meta={<Badge variant="secondary">{entry.type.replaceAll('_', ' ')}</Badge>}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      open={open}
      tags={entry.tags}
      title={entry.uuid}
    >
      {error ? (
        <div className="space-y-3">
          <p className="rounded-md border bg-destructive/5 p-3 text-sm text-destructive-foreground">
            {error.message}
          </p>
          <JsonTree label="Recorded content" value={entry.content} />
        </div>
      ) : (
        <div aria-label="Loading entry details" className="space-y-3" role="status">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}
    </EntryDetailDrawer>
  )
}

export function RegistryEntryDetail({
  detailComponent,
  entry,
  onClose,
  open,
  presentation = 'drawer',
}: RegisteredEntryDetailProps & {
  detailComponent?: RegisteredEntryDetailComponent
  presentation?: EntryDetailPresentation
}) {
  const [loaded, setLoaded] = useState<{
    component: RegisteredEntryDetailComponent
    type: EntryType
  } | null>(detailComponent ? { component: detailComponent, type: entry.type } : null)
  const [loadError, setLoadError] = useState<{ error: Error; type: EntryType } | null>(null)

  useEffect(() => {
    if (detailComponent) {
      setLoaded({ component: detailComponent, type: entry.type })
      setLoadError(null)
      return
    }

    let active = true
    setLoadError(null)
    void loadEntryDetailComponent(entry.type)
      .then((component) => {
        if (active) setLoaded({ component, type: entry.type })
      })
      .catch((cause: unknown) => {
        if (!active) return
        setLoadError({
          error: cause instanceof Error ? cause : new Error('Unable to load entry details'),
          type: entry.type,
        })
      })
    return () => {
      active = false
    }
  }, [detailComponent, entry.type])

  const DetailComponent =
    detailComponent ?? (loaded?.type === entry.type ? loaded.component : undefined)
  const error = loadError?.type === entry.type ? loadError.error : undefined

  return (
    <EntryDetailScope entry={entry} presentation={presentation}>
      {DetailComponent ? (
        <DetailComponent entry={entry} onClose={onClose} open={open} />
      ) : (
        <GenericEntryDetail entry={entry} error={error} onClose={onClose} open={open} />
      )}
    </EntryDetailScope>
  )
}

export function registerEntryType<T extends EntryTypeRegistration>(metadata: T): Readonly<T> {
  const registration = registerMetadata(metadata)
  registrationsByType.set(registration.type, registration)
  return registration
}

export function RegisteredEntryPage({
  registration,
  implementation,
}: {
  registration: EntryTypeRegistration
  implementation: EntryTypeImplementation
}) {
  const [searchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const [selected, setSelected] = useState<StoredEntry | null>(null)
  const [detailEntry, setDetailEntry] = useState<StoredEntry | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const focusedRowRef = useRef(-1)
  const { tags, from, to } = useMemo(() => entryUrlFilterState(searchParams), [searchParams])
  const tag = tags[0]
  const filters = useMemo<EntryFilters>(
    () => ({
      type: registration.type,
      tags: tags.length > 0 ? tags : undefined,
      from,
      to,
      displayOnIndex: true,
      limit: 50,
    }),
    [from, registration.type, tags, to]
  )
  const pagination = useCursorPagination(filters)
  const reload = pagination.reload
  const polling = useNewEntryPolling(pagination.entries, filters, status?.paused ?? true, revision)
  const PageEffect = implementation.pageEffect
  const OverviewComponent = implementation.overviewComponent

  useEffect(() => {
    if (revision > 0) void reload()
  }, [reload, revision])

  useEffect(() => {
    const closeDetail = () => setSelected(null)
    window.addEventListener(CLOSE_DETAIL_EVENT, closeDetail)
    return () => window.removeEventListener(CLOSE_DETAIL_EVENT, closeDetail)
  }, [])

  useEffect(() => {
    const focusRow = (event: Event) => {
      if (selected !== null || !(event instanceof CustomEvent)) return
      const direction = event.detail?.direction
      if (direction !== 1 && direction !== -1) return

      const buttons = Array.from(
        pageRef.current?.querySelectorAll<HTMLButtonElement>('tbody button[type="button"]') ?? []
      )
      if (buttons.length === 0) return

      const activeIndex = buttons.findIndex((button) => button === document.activeElement)
      const currentIndex = activeIndex >= 0 ? activeIndex : focusedRowRef.current
      const nextIndex =
        currentIndex < 0
          ? direction > 0
            ? 0
            : buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, currentIndex + direction))
      focusedRowRef.current = nextIndex
      buttons[nextIndex]?.focus()
      buttons[nextIndex]?.scrollIntoView({ block: 'nearest' })
    }

    window.addEventListener(ROW_NAVIGATION_EVENT, focusRow)
    return () => window.removeEventListener(ROW_NAVIGATION_EVENT, focusRow)
  }, [selected])

  return (
    <div className="space-y-4" ref={pageRef}>
      {PageEffect && <PageEffect />}
      <PageHeader
        aside={
          tags.length > 0 ? (
            <span className="flex flex-wrap items-center justify-end gap-1.5 text-2xs text-muted-foreground">
              <Route aria-hidden="true" className="size-3.5" />
              {tags.map((activeTag) => (
                <TagChip key={activeTag} tag={activeTag} />
              ))}
            </span>
          ) : undefined
        }
        description={implementation.description}
        title={implementation.heading}
      />

      <EntryFilterBar />

      {OverviewComponent && <OverviewComponent entries={pagination.entries} />}

      <EntryIndexTable
        caption={implementation.caption}
        columns={implementation.columns}
        emptyDescription={implementation.emptyDescription(tag)}
        emptyTitle={implementation.emptyTitle(tag)}
        error={pagination.error}
        hasMore={pagination.hasMore}
        loading={pagination.loading}
        loadingMore={pagination.loadingMore}
        newCount={polling.pending.length}
        onAcceptNew={() => pagination.prepend(polling.accept())}
        onLoadMore={() => void pagination.loadMore()}
        onRetry={() => void pagination.reload()}
        onRowOpen={(entry) => {
          setDetailEntry(entry)
          setSelected(entry)
        }}
        rowLabel={implementation.rowLabel}
        rows={pagination.entries}
      />

      {detailEntry && (
        <RegistryEntryDetail
          detailComponent={implementation.detailComponent}
          entry={detailEntry}
          onClose={() => setSelected(null)}
          open={selected !== null}
        />
      )}
    </div>
  )
}
