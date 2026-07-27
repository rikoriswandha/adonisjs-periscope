import { ArrowUpRight, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import { EntryIndexTable } from '@/components/entry-index-table'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { PageHeader } from '@/components/page-header'
import { TagChip } from '@/components/tag-chip'
import { Badge } from '@/components/ui/badge'
import { useDashboard } from '@/dashboard-context'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import { globalSearchFilters, normalizeExactTag } from '@/lib/global-search'
import type { EntryFilters, StoredEntry } from '@/types'
import type { EntryTypeImplementation } from '@/entry-type-registry'
import { entryTypeLabel, getWave2EntryType } from '@/wave2-entry-types'

function entrySummary(entry: StoredEntry): string {
  const content = entry.content
  for (const key of ['subject', 'command', 'url', 'ability', 'model', 'key', 'message']) {
    const value = content[key]
    if (typeof value === 'string' && value.trim()) return truncate(value, 120)
  }
  return entry.uuid
}

const columns: EntryColumn[] = [
  {
    key: 'entry',
    header: 'Entry',
    primary: true,
    cell: (entry) => (
      <div className="min-w-0">
        <div className="max-w-xl truncate text-sm font-medium" title={entrySummary(entry)}>
          {entrySummary(entry)}
        </div>
        <div className="mt-1 font-mono text-2xs text-muted-foreground">{entry.uuid}</div>
      </div>
    ),
  },
  {
    key: 'type',
    header: 'Type',
    className: 'w-32',
    cell: (entry) => <Badge variant="secondary">{entryTypeLabel(entry.type)}</Badge>,
  },
  {
    key: 'tags',
    header: 'Tags',
    className: 'w-72',
    cell: (entry) => (
      <div className="flex max-w-72 flex-wrap gap-1.5">
        {entry.tags.map((tag) => (
          <TagChip key={tag} tag={tag} />
        ))}
      </div>
    ),
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36',
    cell: (entry) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground" title={entry.createdAt}>
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
  {
    key: 'open',
    header: '',
    className: 'w-10 text-right',
    cell: () => (
      <ArrowUpRight aria-hidden="true" className="ms-auto size-4 text-muted-foreground" />
    ),
  },
]

export function SearchPage() {
  const [searchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const [selected, setSelected] = useState<StoredEntry | null>(null)
  const [detailEntry, setDetailEntry] = useState<StoredEntry | null>(null)
  const [implementation, setImplementation] = useState<EntryTypeImplementation | null>(null)
  const tag = normalizeExactTag(searchParams.get('tag'))
  const filters = useMemo<EntryFilters>(() => globalSearchFilters(tag) ?? { limit: 50 }, [tag])
  const pagination = useCursorPagination(filters, { enabled: Boolean(tag) })
  const reload = pagination.reload
  const polling = useNewEntryPolling(
    pagination.entries,
    filters,
    !tag || (status?.paused ?? true),
    revision
  )
  const registration = detailEntry ? getWave2EntryType(detailEntry.type) : undefined
  const DetailComponent = implementation?.detailComponent

  useEffect(() => {
    let active = true
    setImplementation(null)

    if (registration) {
      void registration.load().then((loaded) => {
        if (active) setImplementation(loaded)
      })
    }

    return () => {
      active = false
    }
  }, [registration])

  useEffect(() => {
    if (revision > 0 && tag) void reload()
  }, [reload, revision, tag])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Exact-tag search"
        description="Search every recorded entry type without changing the screen you started from."
        aside={tag && <TagChip tag={tag} />}
      />

      {tag ? (
        <EntryIndexTable
          caption={`Entries carrying the exact tag ${tag}`}
          columns={columns}
          emptyDescription={`No recorded entry carries the exact tag “${tag}”. Check capitalization and punctuation, or try another tag.`}
          emptyTitle="No exact matches"
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
          rowLabel={(entry) => `Inspect ${entryTypeLabel(entry.type)}: ${entrySummary(entry)}`}
          rows={pagination.entries}
        />
      ) : (
        <section className="rounded-md border bg-muted/25 px-4 py-10 text-center">
          <Search aria-hidden="true" className="mx-auto size-5 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-semibold">Enter an exact tag to search</h3>
          <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
            Use the search field above for tags such as Auth:42, status:500, or any free-form tag.
          </p>
        </section>
      )}

      {detailEntry && registration && DetailComponent && (
        <DetailComponent
          entry={detailEntry}
          onClose={() => setSelected(null)}
          open={selected !== null}
        />
      )}
      {detailEntry && !registration && (
        <EntryDetailDrawer
          description={`${entryTypeLabel(detailEntry.type)} · ${formatDateTime(detailEntry.createdAt)}`}
          meta={<Badge variant="secondary">{entryTypeLabel(detailEntry.type)}</Badge>}
          onOpenChange={(open) => !open && setSelected(null)}
          open={selected !== null}
          tags={detailEntry.tags}
          title={entrySummary(detailEntry)}
        >
          <JsonTree label="Recorded content" value={detailEntry.content} />
        </EntryDetailDrawer>
      )}
    </div>
  )
}
