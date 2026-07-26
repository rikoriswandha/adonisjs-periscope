import { ArrowUpRight, Route } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import { EntryIndexTable, type EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
import { useDashboard } from '@/dashboard-context'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useDumpOpenHeartbeat } from '@/hooks/use-dump-open-heartbeat'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { DumpContent, EntryFilters, StoredEntry } from '@/types'

function dumpContent(entry: StoredEntry): DumpContent {
  return entry.content as DumpContent
}

function valueCount(value: unknown): number {
  if (Array.isArray(value)) return value.length
  return value === undefined ? 0 : 1
}

function preview(value: unknown): string {
  if (value === undefined) return 'No values recorded'
  try {
    return truncate(JSON.stringify(value) ?? String(value), 140)
  } catch {
    return truncate(String(value), 140)
  }
}

function callerLabel(content: DumpContent): string {
  if (!content.caller) return 'Caller unavailable'
  return `${content.caller.file}:${content.caller.line}${content.caller.column === undefined ? '' : `:${content.caller.column}`}`
}

const columns: EntryColumn[] = [
  {
    key: 'values',
    header: 'Dumped value',
    primary: true,
    cell: (entry) => {
      const content = dumpContent(entry)
      const serialized = preview(content.values)
      return (
        <div className="min-w-0">
          <div className="max-w-2xl truncate font-mono text-xs font-medium" title={serialized}>
            {serialized}
          </div>
          <div className="mt-1 text-2xs text-muted-foreground">
            {valueCount(content.values)} {valueCount(content.values) === 1 ? 'value' : 'values'}{' '}
            captured
          </div>
        </div>
      )
    },
  },
  {
    key: 'caller',
    header: 'Caller',
    className: 'w-72',
    cell: (entry) => {
      const label = callerLabel(dumpContent(entry))
      return (
        <span
          className="block max-w-72 truncate font-mono text-xs text-muted-foreground"
          title={label}
        >
          {label}
        </span>
      )
    },
  },
  {
    key: 'count',
    header: 'Values',
    className: 'w-20',
    cell: (entry) => (
      <Badge variant="secondary">{valueCount(dumpContent(entry).values)} captured</Badge>
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

export function DumpsPage() {
  useDumpOpenHeartbeat()

  const [searchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const [selected, setSelected] = useState<StoredEntry | null>(null)
  const tag = searchParams.get('tag')?.trim() || undefined
  const filters = useMemo<EntryFilters>(
    () => ({ type: 'dump', tag, displayOnIndex: true, limit: 50 }),
    [tag]
  )
  const pagination = useCursorPagination(filters)
  const reload = pagination.reload
  const polling = useNewEntryPolling(pagination.entries, filters, status?.paused ?? true, revision)

  useEffect(() => {
    if (revision > 0) void reload()
  }, [reload, revision])

  const acceptNew = () => pagination.prepend(polling.accept())
  const content = selected ? dumpContent(selected) : null
  const count = content ? valueCount(content.values) : 0

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold tracking-tight">Application dumps</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Inspect serialized values sent through dump() with their application call site.
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
        caption="Recorded application dumps"
        columns={columns}
        emptyDescription={
          tag
            ? `No dump carries the exact tag “${tag}”. Try another tag or clear the filter.`
            : 'Call dump() in application code while this page is open. Serialized values appear here automatically.'
        }
        emptyTitle={tag ? 'No matching dumps' : 'Waiting for a dump'}
        error={pagination.error}
        hasMore={pagination.hasMore}
        loading={pagination.loading}
        loadingMore={pagination.loadingMore}
        newCount={polling.pending.length}
        onAcceptNew={acceptNew}
        onLoadMore={() => void pagination.loadMore()}
        onRetry={() => void pagination.reload()}
        onRowOpen={setSelected}
        rowLabel={(entry) => `Inspect dump from ${callerLabel(dumpContent(entry))}`}
        rows={pagination.entries}
      />

      <EntryDetailDrawer
        description={
          selected
            ? `${callerLabel(content ?? { values: [] })} · ${formatDateTime(selected.createdAt)}`
            : 'Dump detail'
        }
        meta={
          content && (
            <>
              <Badge variant="info">dump captured</Badge>
              <Badge variant="secondary">
                {count} {count === 1 ? 'value' : 'values'}
              </Badge>
            </>
          )
        }
        onOpenChange={(open) => !open && setSelected(null)}
        open={selected !== null}
        title={content ? truncate(preview(content.values), 96) : 'Dump detail'}
      >
        {content && (
          <>
            {content.caller ? (
              <dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-3">
                <div className="sm:col-span-3">
                  <dt className="text-xs text-muted-foreground">Source file</dt>
                  <dd className="mt-1 max-h-24 overflow-auto break-all font-mono text-sm">
                    {content.caller.file}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Line</dt>
                  <dd className="mt-1 font-mono text-sm">{content.caller.line}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Column</dt>
                  <dd className="mt-1 font-mono text-sm">
                    {content.caller.column ?? 'Unavailable'}
                  </dd>
                </div>
              </dl>
            ) : (
              <section className="rounded-lg border bg-muted/25 p-4">
                <h3 className="text-sm font-semibold">Application caller unavailable</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Periscope could not identify an application frame above this dump call. The
                  captured values remain available below.
                </p>
              </section>
            )}

            <JsonTree label="Dumped values" value={content.values} />
          </>
        )}
      </EntryDetailDrawer>
    </div>
  )
}
