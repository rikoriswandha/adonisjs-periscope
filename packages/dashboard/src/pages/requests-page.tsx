import { ArrowUpRight, Route } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { DurationBadge } from '@/components/duration-badge'
import { EntryIndexTable, type EntryColumn } from '@/components/entry-index-table'
import { RequestActivityChart } from '@/components/request-activity-chart'
import { StatusBadge } from '@/components/status-badge'
import { TagChip } from '@/components/tag-chip'
import { Badge } from '@/components/ui/badge'
import { useDashboard } from '@/dashboard-context'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { formatRelativeTime, truncate } from '@/lib/format'
import type { EntryFilters, RequestContent, StoredEntry } from '@/types'

function requestContent(entry: StoredEntry): RequestContent {
  return entry.content as RequestContent
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
          <div className="mt-1 max-w-xl truncate text-xs text-muted-foreground">
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

export function RequestsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const tag = searchParams.get('tag')?.trim() || undefined
  const filters = useMemo<EntryFilters>(
    () => ({ type: 'request', tag, displayOnIndex: true, limit: 50 }),
    [tag]
  )
  const pagination = useCursorPagination(filters)
  const reload = pagination.reload
  const polling = useNewEntryPolling(pagination.entries, filters, status?.paused ?? true, revision)

  useEffect(() => {
    if (revision > 0) void reload()
  }, [reload, revision])

  const acceptNew = () => pagination.prepend(polling.accept())

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold tracking-tight">HTTP request batches</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Follow a request from ingress through queries, logs, and exceptions in sequence order.
          </p>
        </div>
        {tag && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Route aria-hidden="true" className="size-3.5" />
            <TagChip tag={tag} />
          </span>
        )}
      </section>

      <RequestActivityChart entries={pagination.entries} />

      <EntryIndexTable
        caption="Recorded HTTP requests"
        columns={columns}
        emptyDescription={
          tag
            ? `No request carries the exact tag “${tag}”. Try another tag or clear the filter.`
            : 'Send a request through the application. New request batches appear here automatically.'
        }
        emptyTitle={tag ? 'No matching requests' : 'Waiting for the first request'}
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
