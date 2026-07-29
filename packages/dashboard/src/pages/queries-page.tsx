import { ArrowUpRight, Database, MapPinOff, Route, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { DurationBadge } from '@/components/duration-badge'
import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import { EntryIndexTable, type EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { PageHeader } from '@/components/page-header'
import { SqlBlock } from '@/components/sql-block'
import { TagChip } from '@/components/tag-chip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useDashboard } from '@/dashboard-context'
import { RegistryEntryDetail } from '@/entry-type-registry'
import type { RegisteredEntryDetailProps } from '@/entry-type-registry'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { api } from '@/lib/api'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import { normalizeExactTags } from '@/lib/global-search'
import type { EntryFilters, QueryContent, StoredEntry } from '@/types'

function queryContent(entry: StoredEntry): QueryContent {
  return entry.content as QueryContent
}

const columns: EntryColumn[] = [
  {
    key: 'sql',
    header: 'Query',
    primary: true,
    cell: (entry) => {
      const content = queryContent(entry)
      return (
        <div className="min-w-0">
          <div className="max-w-2xl truncate font-mono text-xs font-medium" title={content.sql}>
            {truncate(content.sql.replace(/\s+/g, ' '), 140)}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge size="sm" variant="secondary">
              {content.method}
            </Badge>
            {content.inTransaction && (
              <Badge size="sm" variant="info">
                transaction
              </Badge>
            )}
            {content.error && (
              <Badge size="sm" variant="destructive">
                failed
              </Badge>
            )}
          </div>
        </div>
      )
    },
  },
  {
    key: 'connection',
    header: 'Connection',
    className: 'w-36',
    cell: (entry) => (
      <span className="font-mono text-xs text-muted-foreground">
        {queryContent(entry).connection}
      </span>
    ),
  },
  {
    key: 'duration',
    header: 'Duration',
    className: 'w-28',
    cell: (entry) => (
      <DurationBadge slow={entry.tags.includes('slow')} value={queryContent(entry).durationMs} />
    ),
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36',
    cell: (entry) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground">
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

export function QueryEntryDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const { status } = useDashboard()
  const [batchEntries, setBatchEntries] = useState<StoredEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const content = queryContent(entry)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    api
      .getBatch(entry.batchId, controller.signal)
      .then(setBatchEntries)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause : new Error('Unable to inspect this batch'))
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [entry.batchId])

  const occurrenceCount = entry.familyHash
    ? Math.max(
        1,
        batchEntries.filter(
          (candidate) => candidate.type === 'query' && candidate.familyHash === entry.familyHash
        ).length
      )
    : 1
  const threshold = status?.nPlusOneThreshold ?? 5
  const isNPlusOne = occurrenceCount >= threshold

  return (
    <EntryDetailDrawer
      description={`${content.connection} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <>
          <DurationBadge slow={entry.tags.includes('slow')} value={content.durationMs} />
          {isNPlusOne && <Badge variant="warning">possible n+1</Badge>}
          {content.error && <Badge variant="destructive">failed</Badge>}
        </>
      }
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(content.sql.replace(/\s+/g, ' '), 96)}
    >
      <SqlBlock bindings={content.bindings} sql={content.sql} />

      <section className="rounded-md border bg-muted/25 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Query shape in this batch</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Entries sharing the same normalized SQL family hash.
            </p>
          </div>
          {loading ? (
            <Skeleton className="h-6 w-24" />
          ) : (
            <Badge size="lg" variant={isNPlusOne ? 'warning' : 'secondary'}>
              {occurrenceCount} {occurrenceCount === 1 ? 'occurrence' : 'occurrences'}
            </Badge>
          )}
        </div>
        {isNPlusOne && (
          <p className="mt-3 flex items-start gap-2 text-sm text-warning-foreground">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            This meets the configured n+1 hint threshold of {threshold}. Check whether the query
            runs once per record.
          </p>
        )}
        {error && <p className="mt-3 text-xs text-destructive-foreground">{error.message}</p>}
      </section>

      <dl className="grid gap-2.5 rounded-md border p-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Connection</dt>
          <dd className="mt-0.5 font-mono text-sm">{content.connection}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Operation</dt>
          <dd className="mt-0.5 font-mono text-sm">{content.method}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Model</dt>
          <dd className="mt-0.5 text-sm">{content.model ?? 'Not associated with a model'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Family hash</dt>
          <dd className="mt-0.5 truncate font-mono text-xs" title={entry.familyHash ?? undefined}>
            {entry.familyHash ?? 'Unavailable'}
          </dd>
        </div>
      </dl>

      <section className="flex items-start gap-3 rounded-md border bg-muted/25 p-3">
        <MapPinOff aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-semibold">Call location unavailable</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Lucid query events do not expose a reliable application call site. Use the batch
            timeline and route tags to trace the code path without recording a misleading stack.
          </p>
        </div>
      </section>

      {content.error && <JsonTree label="Database error" value={content.error} />}

      <Button
        render={<Link to={`/requests/${encodeURIComponent(entry.batchId)}`} />}
        variant="outline"
      >
        <Database aria-hidden="true" />
        Open request batch
      </Button>
    </EntryDetailDrawer>
  )
}

export function QueriesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const [selected, setSelected] = useState<StoredEntry | null>(null)
  const slowOnly = searchParams.get('slow') === 'true'
  const activeTags = useMemo(() => normalizeExactTags(searchParams.getAll('tag')), [searchParams])
  const tag = activeTags[0]
  const filters = useMemo<EntryFilters>(
    () => ({
      type: 'query',
      tags: normalizeExactTags([...activeTags, slowOnly ? 'slow' : undefined]),
      displayOnIndex: true,
      limit: 50,
    }),
    [activeTags, slowOnly]
  )
  const pagination = useCursorPagination(filters)
  const reload = pagination.reload
  const polling = useNewEntryPolling(pagination.entries, filters, status?.paused ?? true, revision)

  useEffect(() => {
    if (revision > 0) void reload()
  }, [reload, revision])


  const acceptNew = () => pagination.prepend(polling.accept())
  const openQuery = (entry: StoredEntry) => setSelected(entry)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Database queries"
        description="Inspect normalized query shapes, bindings, connection context, and repetition within a request."
        aside={
          <div className="flex flex-wrap items-center gap-2">
            {tag && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Route aria-hidden="true" className="size-3.5" />
                <TagChip tag={tag} />
              </span>
            )}
            <label className="flex min-h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-xs font-medium">
              Slow only
              <Switch
                aria-label="Show slow queries only"
                checked={slowOnly}
                onCheckedChange={(checked) => {
                  const next = new URLSearchParams(searchParams)
                  if (checked) next.set('slow', 'true')
                  else next.delete('slow')
                  setSearchParams(next)
                }}
              />
            </label>
          </div>
        }
      />

      <EntryIndexTable
        caption="Recorded database queries"
        columns={columns}
        emptyDescription={
          slowOnly
            ? 'No query carries the exact slow tag in the selected result set. Turn off the filter to inspect all queries.'
            : tag
              ? `No query carries the exact tag “${tag}”. Try another tag or clear the filter.`
              : 'Run a Lucid query while debug events are enabled. It will appear here automatically.'
        }
        emptyTitle={slowOnly ? 'No slow queries' : tag ? 'No matching queries' : 'Waiting for queries'}
        error={pagination.error}
        hasMore={pagination.hasMore}
        loading={pagination.loading}
        loadingMore={pagination.loadingMore}
        newCount={polling.pending.length}
        onAcceptNew={acceptNew}
        onLoadMore={() => void pagination.loadMore()}
        onRetry={() => void pagination.reload()}
        onRowOpen={openQuery}
        rowLabel={(entry) => `Inspect query: ${truncate(queryContent(entry).sql, 80)}`}
        rows={pagination.entries}
      />

      {selected && (
        <RegistryEntryDetail
          detailComponent={QueryEntryDetail}
          entry={selected}
          onClose={() => setSelected(null)}
          open={selected !== null}
        />
      )}
    </div>
  )
}
