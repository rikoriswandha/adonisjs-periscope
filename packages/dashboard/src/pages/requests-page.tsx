import { ArrowUpRight, Route } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { DurationBadge } from '@/components/duration-badge'
import { EntryIndexTable, type EntryColumn } from '@/components/entry-index-table'
import { PageHeader } from '@/components/page-header'
import { RequestActivityChart } from '@/components/request-activity-chart'
import { StatusBadge } from '@/components/status-badge'
import { TagChip } from '@/components/tag-chip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useDashboard } from '@/dashboard-context'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { formatRelativeTime, truncate } from '@/lib/format'
import { normalizeExactTags } from '@/lib/global-search'
import type { EntryFilters, RequestContent, StoredEntry } from '@/types'

function requestContent(entry: StoredEntry): RequestContent {
  return entry.content as RequestContent
}

const requestKinds = ['document', 'inertia', 'xhr', 'asset'] as const
type RequestKind = (typeof requestKinds)[number]

const kindFilters: ReadonlyArray<{ label: string; value?: RequestKind }> = [
  { label: 'All' },
  { label: 'Document', value: 'document' },
  { label: 'Inertia', value: 'inertia' },
  { label: 'XHR', value: 'xhr' },
  { label: 'Asset', value: 'asset' },
]

function isRequestKind(value: string | null): value is RequestKind {
  return requestKinds.includes(value as RequestKind)
}

const statusClasses = ['2xx', '3xx', '4xx', '5xx'] as const
type StatusClass = (typeof statusClasses)[number]

function isStatusClass(value: string | null): value is StatusClass {
  return statusClasses.includes(value as StatusClass)
}

const columns: EntryColumn[] = [
  {
    key: 'method',
    header: 'Method',
    className: 'w-24',
    cell: (entry) => (
      <Badge className="font-mono" variant="outline">
        {requestContent(entry).method}
      </Badge>
    ),
  },
  {
    key: 'path',
    header: 'Path',
    primary: true,
    cell: (entry) => {
      const content = requestContent(entry)
      return (
        <div className="min-w-0">
          <div className="max-w-xl truncate font-mono text-xs font-medium" title={content.url}>
            {truncate(content.url, 120)}
          </div>
          <div className="mt-0.5 max-w-xl truncate text-2xs text-muted-foreground">
            {content.routePattern ?? content.routeName ?? 'Unmatched route'}
          </div>
        </div>
      )
    },
  },
  {
    key: 'status',
    header: 'Status',
    className: 'w-24',
    cell: (entry) => <StatusBadge status={requestContent(entry).status} />,
  },
  {
    key: 'duration',
    header: 'Duration',
    className: 'w-28',
    cell: (entry) => <DurationBadge value={requestContent(entry).durationMs} />,
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36',
    cell: (entry) => (
      <span
        className="whitespace-nowrap font-mono text-2xs tabular-nums text-muted-foreground"
        title={entry.createdAt}
      >
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
  {
    key: 'open',
    header: '',
    className: 'w-10 text-right',
    cell: () => (
      <ArrowUpRight aria-hidden="true" className="ms-auto size-3.5 text-muted-foreground" />
    ),
  },
]

export function RequestsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const activeTags = useMemo(() => normalizeExactTags(searchParams.getAll('tag')), [searchParams])
  const tag = activeTags[0]
  const requestedKind = searchParams.get('kind')
  const kind = isRequestKind(requestedKind) ? requestedKind : undefined
  const requestedStatus = searchParams.get('status')
  const statusClass = isStatusClass(requestedStatus) ? requestedStatus : undefined
  const filters = useMemo<EntryFilters>(
    () => ({
      type: 'request',
      tags: normalizeExactTags([
        ...activeTags,
        kind ? `kind:${kind}` : undefined,
        statusClass ? `status:${statusClass}` : undefined,
      ]),
      displayOnIndex: true,
      limit: 50,
    }),
    [activeTags, kind, statusClass]
  )
  const pagination = useCursorPagination(filters)
  const reload = pagination.reload
  const polling = useNewEntryPolling(pagination.entries, filters, status?.paused ?? true, revision)

  useEffect(() => {
    if (revision > 0) void reload()
  }, [reload, revision])

  const acceptNew = () => pagination.prepend(polling.accept())

  const selectKind = (nextKind?: RequestKind) => {
    const next = new URLSearchParams(searchParams)
    if (nextKind) next.set('kind', nextKind)
    else next.delete('kind')
    setSearchParams(next)
  }

  const selectStatus = (nextStatus?: StatusClass) => {
    const next = new URLSearchParams(searchParams)
    if (nextStatus) next.set('status', nextStatus)
    else next.delete('status')
    setSearchParams(next)
  }

  return (
    <div className="space-y-4">
      <PageHeader
        aside={
          tag ? (
            <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Route aria-hidden="true" className="size-3.5" />
              <TagChip tag={tag} />
            </span>
          ) : undefined
        }
        description="Follow a request from ingress through queries, logs, and exceptions in sequence order."
        title="HTTP request batches"
      />

      <RequestActivityChart entries={pagination.entries} />

      <div className="flex flex-col gap-1.5">
        <div
          aria-label="Filter requests by kind"
          className="flex flex-wrap items-center gap-1.5"
          role="group"
        >
          <span className="mr-0.5 text-2xs font-medium text-muted-foreground">Kind</span>
          {kindFilters.map((filter) => {
            const selected = kind === filter.value
            return (
              <Button
                aria-pressed={selected}
                key={filter.label}
                onClick={() => selectKind(filter.value)}
                size="xs"
                type="button"
                variant={selected ? 'secondary' : 'ghost'}
              >
                {filter.label}
              </Button>
            )
          })}
        </div>
        <div
          aria-label="Filter requests by status class"
          className="flex flex-wrap items-center gap-1.5"
          role="group"
        >
          <span className="mr-0.5 text-2xs font-medium text-muted-foreground">Status</span>
          <Button
            aria-pressed={!statusClass}
            onClick={() => selectStatus()}
            size="xs"
            type="button"
            variant={!statusClass ? 'secondary' : 'ghost'}
          >
            All
          </Button>
          {statusClasses.map((value) => (
            <Button
              aria-pressed={statusClass === value}
              key={value}
              onClick={() => selectStatus(value)}
              size="xs"
              type="button"
              variant={statusClass === value ? 'secondary' : 'ghost'}
            >
              {value}
            </Button>
          ))}
        </div>
      </div>

      <EntryIndexTable
        caption="Recorded HTTP requests"
        columns={columns}
        emptyDescription={
          tag
            ? `No request carries the exact tag “${tag}” with the selected predicates.`
            : statusClass
              ? `No ${statusClass} requests match the selected kind. New matching requests will appear here automatically.`
              : kind
                ? `No ${kind} requests recorded yet. New matching requests will appear here automatically.`
                : 'Send a request through the application. New request batches appear here automatically.'
        }
        emptyTitle={
          tag
            ? 'No matching requests'
            : statusClass
              ? `No ${statusClass} requests`
              : kind
                ? `No ${kind} requests`
                : 'Waiting for the first request'
        }
        error={pagination.error}
        hasMore={pagination.hasMore}
        loading={pagination.loading}
        loadingMore={pagination.loadingMore}
        newCount={polling.pending.length}
        onAcceptNew={acceptNew}
        onLoadMore={() => void pagination.loadMore()}
        onRetry={() => void pagination.reload()}
        onRowOpen={(entry) =>
          navigate(
            `/requests/${encodeURIComponent(entry.batchId)}${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`
          )
        }
        rowLabel={(entry) => {
          const content = requestContent(entry)
          return `Open ${content.method} ${content.url} batch`
        }}
        rows={pagination.entries}
      />
    </div>
  )
}
