import { Route } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'

import { EntryIndexTable } from '@/components/entry-index-table'
import type { EntryColumn } from '@/components/entry-index-table'
import { TagChip } from '@/components/tag-chip'
import { useDashboard } from '@/dashboard-context'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { normalizeExactTag } from '@/lib/global-search'
import { registerEntryType as registerMetadata } from '@/lib/entry-type-registration'
import type { EntryFilters, EntryType, StoredEntry } from '@/types'

export type RegisteredEntryDetailProps = {
  entry: StoredEntry
  onClose: () => void
}

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

export function registerEntryType<T extends EntryTypeRegistration>(metadata: T): Readonly<T> {
  return registerMetadata(metadata)
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
  const tag = normalizeExactTag(searchParams.get('tag'))
  const filters = useMemo<EntryFilters>(
    () => ({ type: registration.type, tag, displayOnIndex: true, limit: 50 }),
    [registration.type, tag]
  )
  const pagination = useCursorPagination(filters)
  const reload = pagination.reload
  const polling = useNewEntryPolling(pagination.entries, filters, status?.paused ?? true, revision)
  const DetailComponent = implementation.detailComponent
  const PageEffect = implementation.pageEffect
  const OverviewComponent = implementation.overviewComponent

  useEffect(() => {
    if (revision > 0) void reload()
  }, [reload, revision])

  return (
    <div className="space-y-5">
      {PageEffect && <PageEffect />}
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold tracking-tight">{implementation.heading}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {implementation.description}
          </p>
        </div>
        {tag && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Route aria-hidden="true" className="size-3.5" />
            <TagChip tag={tag} />
          </span>
        )}
      </section>

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
        onRowOpen={setSelected}
        rowLabel={implementation.rowLabel}
        rows={pagination.entries}
      />

      {selected && <DetailComponent entry={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
