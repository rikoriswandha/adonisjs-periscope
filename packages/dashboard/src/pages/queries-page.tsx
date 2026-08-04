import { ArrowUpRight, Database, MapPinOff, Route, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { DurationBadge } from '@/components/duration-badge'
import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import { Panel, PanelBody, PanelHeader, SignalMeter, StatusDot } from '@/components/instrument'
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
import { detectNPlusOneWarnings } from '@/lib/n-plus-one'
import type { EntryFilters, QueryContent, StoredEntry } from '@/types'

function queryContent(entry: StoredEntry): QueryContent {
  return entry.content as QueryContent
}

function queryColumns(maxDurationMs: number): EntryColumn[] {
  return [
  {
    key: 'sql',
    header: 'Query',
    primary: true,
    cell: (entry) => {
      const content = queryContent(entry)
      return (
        <div className="min-w-0 overflow-hidden">
          <div className="num max-w-2xl truncate text-xs font-medium text-ink" title={content.sql}>
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
    className: 'w-36 max-w-36',
    cell: (entry) => {
      const connection = queryContent(entry).connection
      return (
        <span className="num block truncate text-xs text-ink-3" title={connection}>
          {connection}
        </span>
      )
    },
  },
  {
    key: 'duration',
    header: 'Duration',
    className: 'w-32 text-right',
    cell: (entry) => {
      const durationMs = queryContent(entry).durationMs
      const slow = entry.tags.includes('slow')
      return (
        <div className="ms-auto w-24 space-y-1 text-right">
          <DurationBadge slow={slow} value={durationMs} />
          <SignalMeter
            className="ms-auto"
            max={maxDurationMs}
            signal={slow ? 'warn' : 'neutral'}
            value={durationMs ?? 0}
          />
        </div>
      )
    },
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
}

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

  const threshold = status?.nPlusOneThreshold ?? 5
  const warning = entry.familyHash
    ? detectNPlusOneWarnings(batchEntries, threshold).find(
        (candidate) => candidate.familyHash === entry.familyHash
      )
    : undefined
  const occurrenceCount = entry.familyHash
    ? Math.max(
        1,
        batchEntries.filter(
          (candidate) => candidate.type === 'query' && candidate.familyHash === entry.familyHash
        ).length
      )
    : 1
  const isNPlusOne = warning !== undefined

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

      <Panel className={isNPlusOne ? 'bg-sig-warn/10' : undefined}>
        <PanelHeader
          action={
            loading ? (
              <Skeleton className="h-4 w-20" />
            ) : (
              <span className="num inline-flex items-center gap-2 text-xs text-ink-2">
                <StatusDot signal={isNPlusOne ? 'warn' : 'neutral'} />
                {occurrenceCount} {occurrenceCount === 1 ? 'occurrence' : 'occurrences'}
              </span>
            )
          }
          icon={
            <TriangleAlert
              aria-hidden="true"
              className={isNPlusOne ? 'text-sig-warn' : 'text-ink-3'}
            />
          }
          title="N+1 detection"
        />
        <PanelBody>
          <p className="text-xs leading-5 text-ink-3">
            Entries sharing the same normalized SQL family hash in this request batch.
          </p>
          {isNPlusOne && (
            <p className="mt-2 text-sm font-medium text-sig-warn">
              This meets the configured N+1 hint threshold of {threshold}. Check whether the query
              runs once per record.
            </p>
          )}
          {error && <p className="mt-2 text-xs text-sig-error">{error.message}</p>}
        </PanelBody>
      </Panel>

      <dl className="grid gap-2.5 rounded-md border p-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Connection</dt>
          <dd className="num mt-0.5 truncate text-sm" title={content.connection}>
            {content.connection}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Operation</dt>
          <dd className="num mt-0.5 truncate text-sm">{content.method}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Model</dt>
          <dd className="mt-0.5 truncate text-sm" title={content.model ?? undefined}>
            {content.model ?? 'Not associated with a model'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Family hash</dt>
          <dd className="num mt-0.5 truncate text-xs" title={entry.familyHash ?? undefined}>
            {entry.familyHash ?? 'Unavailable'}
          </dd>
        </div>
      </dl>

      <section className="well flex min-w-0 items-start gap-3 p-3">
        <MapPinOff aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Call location unavailable</h3>
          <p className="mt-1 text-xs leading-5 text-ink-3">
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
  const maxDurationMs = Math.max(
    0,
    ...pagination.entries.map((entry) => queryContent(entry).durationMs ?? 0)
  )
  const columns = useMemo(() => queryColumns(maxDurationMs), [maxDurationMs])

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
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
                <Route aria-hidden="true" className="size-3.5 shrink-0" />
                <TagChip tag={tag} />
              </span>
            )}
            <label className="flex h-[var(--control-h)] items-center gap-2 rounded-sm border border-edge bg-panel px-2.5 text-xs font-medium text-ink-2">
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
