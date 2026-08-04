import { ArrowUpRight, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'

import { EntryFilterBar } from '@/components/entry-filter-bar'
import { EntryIndexTable } from '@/components/entry-index-table'
import type { EntryColumn } from '@/components/entry-index-table'
import { Panel, PanelBody, PanelHeader } from '@/components/instrument'
import { PageHeader } from '@/components/page-header'
import { TagChip } from '@/components/tag-chip'
import { Button } from '@/components/ui/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useDashboard } from '@/dashboard-context'
import { RegistryEntryDetail } from '@/entry-type-registry'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { formatRelativeTime, truncate } from '@/lib/format'
import { entryUrlFilterState, globalSearchFilters } from '@/lib/global-search'
import { ENTRY_TYPES } from '@/types'
import type { EntryFilters, EntryType, StoredEntry } from '@/types'
import { entryTypeLabel } from '@/wave2-entry-types'

function entrySummary(entry: StoredEntry): string {
  const content = entry.content
  for (const key of ['subject', 'command', 'url', 'ability', 'model', 'key', 'message']) {
    const value = content[key]
    if (typeof value === 'string' && value.trim()) return truncate(value, 120)
  }
  return entry.uuid
}

function groupedSearchRows(entries: StoredEntry[]): {
  rows: StoredEntry[]
  groupHeadByUuid: Map<string, { type: EntryType; count: number }>
} {
  const entriesByType = new Map<EntryType, StoredEntry[]>()
  for (const entry of entries) {
    const group = entriesByType.get(entry.type)
    if (group) group.push(entry)
    else entriesByType.set(entry.type, [entry])
  }

  const rows: StoredEntry[] = []
  const groupHeadByUuid = new Map<string, { type: EntryType; count: number }>()
  for (const type of ENTRY_TYPES) {
    const group = entriesByType.get(type)
    if (!group?.length) continue
    groupHeadByUuid.set(group[0].uuid, { type, count: group.length })
    rows.push(...group)
  }
  return { rows, groupHeadByUuid }
}

function searchColumns(
  groupHeadByUuid: Map<string, { type: EntryType; count: number }>
): EntryColumn[] {
  return [
    {
      key: 'type',
      header: 'Entry type',
      className: 'w-36 align-top',
      cell: (entry) => {
        const group = groupHeadByUuid.get(entry.uuid)
        if (!group) return null
        return (
          <div className="flex items-baseline gap-1.5 py-0.5">
            <h3 className="micro-label text-ink-2">{entryTypeLabel(group.type)}</h3>
            <span className="num text-micro text-ink-4">{group.count.toLocaleString()}</span>
          </div>
        )
      },
    },
    {
      key: 'entry',
      header: 'Entry',
      primary: true,
      cell: (entry) => {
        const group = groupHeadByUuid.get(entry.uuid)
        return (
          <div className="min-w-0">
            {group && (
              <div className="mb-1 flex items-baseline gap-1.5 sm:hidden">
                <h3 className="micro-label text-ink-2">{entryTypeLabel(group.type)}</h3>
                <span className="num text-micro text-ink-4">{group.count.toLocaleString()}</span>
              </div>
            )}
            <div className="max-w-xl truncate text-sm font-medium text-ink" title={entrySummary(entry)}>
              {entrySummary(entry)}
            </div>
            <div className="num mt-1 truncate text-micro text-ink-3" title={entry.uuid}>
              {entry.uuid}
            </div>
          </div>
        )
      },
    },
    {
      key: 'tags',
      header: 'Tags',
      className: 'w-72',
      cell: (entry) => (
        <div className="flex max-w-72 flex-wrap gap-1">
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
        <span className="num whitespace-nowrap text-xs text-ink-3" title={entry.createdAt}>
          {formatRelativeTime(entry.createdAt)}
        </span>
      ),
    },
    {
      key: 'open',
      header: '',
      className: 'w-10 text-right',
      cell: () => <ArrowUpRight aria-hidden="true" className="ms-auto size-4 text-ink-3" />,
    },
  ]
}

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
  const grouped = useMemo(() => groupedSearchRows(pagination.entries), [pagination.entries])
  const columns = useMemo(() => searchColumns(grouped.groupHeadByUuid), [grouped.groupHeadByUuid])

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

  const clearTextSearch = () => {
    setTextInput('')
    const next = new URLSearchParams(searchParams)
    next.delete('text')
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

      <Panel aria-label="Search query">
        <PanelHeader icon={<Search aria-hidden="true" />} title="Search all recorded content" />
        <PanelBody className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <form className="min-w-0 flex-1 space-y-1.5" onSubmit={submitTextSearch} role="search">
            <label className="text-xs font-medium text-ink-2" htmlFor="recording-search-text">
              Recorded content
            </label>
            <div className="flex min-w-0 gap-2">
              <InputGroup className="well h-[var(--control-h)] min-w-0 rounded-sm border-edge shadow-none [@media(pointer:coarse)]:h-11">
                <InputGroupInput
                  autoComplete="off"
                  className="num h-[var(--control-h)] text-sm text-ink placeholder:text-ink-3"
                  id="recording-search-text"
                  onChange={(event) => setTextInput(event.target.value)}
                  placeholder="Search requests, messages, commands, payloads…"
                  type="search"
                  value={textInput}
                />
                <InputGroupAddon className="text-ink-3">
                  <Search aria-hidden="true" />
                </InputGroupAddon>
                {textInput.length > 0 && (
                  <InputGroupAddon align="inline-end">
                    <Button
                      aria-label="Clear recorded content search"
                      onClick={clearTextSearch}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </InputGroupAddon>
                )}
              </InputGroup>
              <Button className="h-[var(--control-h)] rounded-sm" type="submit">
                Search
              </Button>
            </div>
          </form>

          <div className="space-y-1.5 sm:w-52">
            <label className="text-xs font-medium text-ink-2" id="recording-search-type-label">
              Entry type
            </label>
            <Select
              items={typeOptions}
              onValueChange={selectType}
              value={filterState.type ?? 'all'}
            >
              <SelectTrigger
                aria-labelledby="recording-search-type-label"
                className="h-[var(--control-h)] rounded-sm border-edge bg-well shadow-none [@media(pointer:coarse)]:h-11"
              >
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
        </PanelBody>
      </Panel>

      <EntryFilterBar />

      {hasFilters ? (
        <EntryIndexTable
          caption="Search results grouped by recorded entry type"
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
          rows={grouped.rows}
        />
      ) : (
        <Panel aria-labelledby="search-start-title">
          <PanelHeader title="What can I search?" />
          <PanelBody className="space-y-4 py-5">
            <div className="max-w-3xl space-y-1.5">
              <h2 className="text-md font-medium text-ink" id="search-start-title">
                Find content across every watcher
              </h2>
              <p className="max-w-[70ch] text-prose text-ink-2">
                Periscope searches the serialized content captured by all watcher types: request URLs
                and payloads, exception messages, queries, mail subjects, commands, jobs, logs, and
                other recorded values. Combine text with exact tags or a time window when you know
                where to look.
              </p>
            </div>
            <div className="well p-3">
              <p className="text-xs font-medium text-ink-2">Start from an entry type</p>
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Search by entry type">
                {ENTRY_TYPES.map((type) => (
                  <Button
                    className="h-[var(--control-h)] rounded-sm"
                    key={type}
                    onClick={() => selectType(type)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {entryTypeLabel(type)}
                  </Button>
                ))}
              </div>
            </div>
          </PanelBody>
        </Panel>
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
