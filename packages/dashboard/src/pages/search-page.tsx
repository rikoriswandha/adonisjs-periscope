import { ArrowUpRight, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'

import { EntryFilterBar } from '@/components/entry-filter-bar'
import { EntryIndexTable } from '@/components/entry-index-table'
import type { EntryColumn } from '@/components/entry-index-table'
import { PageHeader } from '@/components/page-header'
import { TagChip } from '@/components/tag-chip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useDashboard } from '@/dashboard-context'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { formatRelativeTime, truncate } from '@/lib/format'
import { entryUrlFilterState, globalSearchFilters } from '@/lib/global-search'
import { ENTRY_TYPES } from '@/types'
import type { EntryFilters, StoredEntry } from '@/types'
import { RegistryEntryDetail } from '@/entry-type-registry'
import { entryTypeLabel } from '@/wave2-entry-types'

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

const typeOptions = [
  { label: 'All types', value: 'all' },
  ...ENTRY_TYPES.map((type) => ({ label: entryTypeLabel(type), value: type })),
]

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const [selected, setSelected] = useState<StoredEntry | null>(null)
  const [detailEntry, setDetailEntry] = useState<StoredEntry | null>(null)
  const filterState = useMemo(() => entryUrlFilterState(searchParams), [searchParams])
  const activeFilters = useMemo(() => globalSearchFilters(searchParams), [searchParams])
  const filters = useMemo<EntryFilters>(() => activeFilters ?? { limit: 50 }, [activeFilters])
  const [textInput, setTextInput] = useState(filterState.text ?? '')
  const hasFilters = activeFilters !== null
  const pagination = useCursorPagination(filters, { enabled: hasFilters })
  const reload = pagination.reload
  const polling = useNewEntryPolling(
    pagination.entries,
    filters,
    !hasFilters || (status?.paused ?? true),
    revision
  )

  useEffect(() => {
    setTextInput(filterState.text ?? '')
  }, [filterState.text])

  useEffect(() => {
    if (revision > 0 && hasFilters) void reload()
  }, [hasFilters, reload, revision])

  const submitTextSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const next = new URLSearchParams(searchParams)
    const text = textInput.trim()
    if (text) next.set('text', text)
    else next.delete('text')
    setSearchParams(next)
  }

  const selectType = (value: unknown) => {
    const next = new URLSearchParams(searchParams)
    if (typeof value === 'string' && value !== 'all') next.set('type', value)
    else next.delete('type')
    setSearchParams(next)
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Search recordings"
        description="Search serialized entry content, narrow by exact tags and type, or inspect a specific time window."
      />

      <section
        aria-label="Search query"
        className="flex flex-col gap-3 rounded-lg border bg-background p-3 sm:flex-row sm:items-end"
      >
        <form className="min-w-0 flex-1 space-y-1.5" onSubmit={submitTextSearch} role="search">
          <label className="text-xs font-medium" htmlFor="recording-search-text">
            Recorded content
          </label>
          <div className="flex gap-2">
            <Input
              autoComplete="off"
              id="recording-search-text"
              onChange={(event) => setTextInput(event.target.value)}
              placeholder="Search requests, messages, commands, payloads…"
              type="search"
              value={textInput}
            />
            <Button type="submit">
              <Search aria-hidden="true" />
              Search
            </Button>
          </div>
        </form>

        <div className="space-y-1.5 sm:w-48">
          <label className="text-xs font-medium" id="recording-search-type-label">
            Entry type
          </label>
          <Select
            items={typeOptions}
            onValueChange={selectType}
            value={filterState.type ?? 'all'}
          >
            <SelectTrigger aria-labelledby="recording-search-type-label">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All types</SelectItem>
              {ENTRY_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {entryTypeLabel(type)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </section>

      <EntryFilterBar />

      {hasFilters ? (
        <EntryIndexTable
          caption="Search results across all recorded entry types"
          columns={columns}
          emptyDescription="No recorded entry matches every active search filter. Broaden the text, tag, type, or time range and try again."
          emptyTitle="No matching entries"
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
          <h3 className="mt-3 text-sm font-semibold">Start with any search filter</h3>
          <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
            Search recorded content, choose an entry type, add exact tags, or select a time range.
          </p>
        </section>
      )}
      {detailEntry && (
        <RegistryEntryDetail
          entry={detailEntry}
          onClose={() => setSelected(null)}
          open={selected !== null}
        />
      )}
    </div>
  )
}
