import { ArrowUpRight, Route } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import { EntryIndexTable, type EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
import { useDashboard } from '@/dashboard-context'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { CacheContent, EntryFilters, StoredEntry } from '@/types'

function cacheContent(entry: StoredEntry): CacheContent {
  return entry.content as CacheContent
}

function operationVariant(operation: CacheContent['operation']) {
  switch (operation) {
    case 'hit':
      return 'success' as const
    case 'miss':
      return 'warning' as const
    case 'set':
      return 'info' as const
    case 'delete':
    case 'clear':
      return 'destructive' as const
  }
}

const columns: EntryColumn[] = [
  {
    key: 'operation',
    header: 'Operation',
    className: 'w-24',
    cell: (entry) => {
      const operation = cacheContent(entry).operation
      return <Badge variant={operationVariant(operation)}>{operation}</Badge>
    },
  },
  {
    key: 'key',
    header: 'Cache key',
    primary: true,
    cell: (entry) => {
      const content = cacheContent(entry)
      return (
        <div className="min-w-0">
          <div className="max-w-2xl truncate font-mono text-xs font-medium" title={content.key}>
            {content.key ? truncate(content.key, 140) : 'Entire store'}
          </div>
          {content.graced && (
            <Badge className="mt-1.5" size="sm" variant="warning">
              graced response
            </Badge>
          )}
        </div>
      )
    },
  },
  {
    key: 'store',
    header: 'Store',
    className: 'w-32',
    cell: (entry) => (
      <span className="font-mono text-xs text-muted-foreground">{cacheContent(entry).store}</span>
    ),
  },
  {
    key: 'layer',
    header: 'Layer',
    className: 'w-20',
    cell: (entry) => (
      <Badge variant="secondary">{cacheContent(entry).layer?.toUpperCase() ?? 'all'}</Badge>
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

export function CachePage() {
  const [searchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const [selected, setSelected] = useState<StoredEntry | null>(null)
  const tag = searchParams.get('tag')?.trim() || undefined
  const filters = useMemo<EntryFilters>(
    () => ({ type: 'cache', tag, displayOnIndex: true, limit: 50 }),
    [tag]
  )
  const pagination = useCursorPagination(filters)
  const reload = pagination.reload
  const polling = useNewEntryPolling(pagination.entries, filters, status?.paused ?? true, revision)

  useEffect(() => {
    if (revision > 0) void reload()
  }, [reload, revision])

  const acceptNew = () => pagination.prepend(polling.accept())
  const content = selected ? cacheContent(selected) : null
  const hasCapturedValue = content ? Object.prototype.hasOwnProperty.call(content, 'value') : false

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold tracking-tight">Cache operations</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Follow hits, misses, writes, deletions, and clears across stores and cache layers.
          </p>
        </div>
        {tag && (
          <Badge variant="info">
            <Route aria-hidden="true" />
            tag:{tag}
          </Badge>
        )}
      </section>

      <EntryIndexTable
        caption="Recorded cache operations"
        columns={columns}
        emptyDescription={
          tag
            ? `No cache operation carries the exact tag “${tag}”. Try another tag or clear the filter.`
            : 'Read from or write to the application cache. Operations appear here automatically when cache events are enabled.'
        }
        emptyTitle={tag ? 'No matching cache operations' : 'Waiting for cache activity'}
        error={pagination.error}
        hasMore={pagination.hasMore}
        loading={pagination.loading}
        loadingMore={pagination.loadingMore}
        newCount={polling.pending.length}
        onAcceptNew={acceptNew}
        onLoadMore={() => void pagination.loadMore()}
        onRetry={() => void pagination.reload()}
        onRowOpen={setSelected}
        rowLabel={(entry) => {
          const entryContent = cacheContent(entry)
          return `Inspect cache ${entryContent.operation}: ${entryContent.key ?? entryContent.store}`
        }}
        rows={pagination.entries}
      />

      <EntryDetailDrawer
        description={
          selected
            ? `${content?.store ?? 'Cache'} · ${formatDateTime(selected.createdAt)}`
            : 'Cache detail'
        }
        meta={
          content && (
            <>
              <Badge variant={operationVariant(content.operation)}>{content.operation}</Badge>
              <Badge variant="secondary">{content.layer?.toUpperCase() ?? 'all layers'}</Badge>
              {content.graced && <Badge variant="warning">graced response</Badge>}
            </>
          )
        }
        onOpenChange={(open) => !open && setSelected(null)}
        open={selected !== null}
        title={content ? truncate(content.key ?? `Clear ${content.store}`, 96) : 'Cache detail'}
      >
        {content && (
          <>
            <dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Store</dt>
                <dd className="mt-1 break-all font-mono text-sm">{content.store}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Layer</dt>
                <dd className="mt-1 font-mono text-sm">
                  {content.layer?.toUpperCase() ?? 'All layers'}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Cache key</dt>
                <dd className="mt-1 max-h-24 overflow-auto break-all font-mono text-sm">
                  {content.key ?? 'Operation applies to the entire store'}
                </dd>
              </div>
            </dl>

            {hasCapturedValue ? (
              <JsonTree label="Captured cache value" value={content.value} />
            ) : (
              <section className="rounded-lg border bg-muted/25 p-4">
                <h3 className="text-sm font-semibold">No value payload recorded</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Values are omitted for this operation or value capture is disabled. Keys and
                  operation metadata remain available.
                </p>
              </section>
            )}
          </>
        )}
      </EntryDetailDrawer>
    </div>
  )
}
