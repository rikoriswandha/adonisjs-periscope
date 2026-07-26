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
import type { EntryFilters, ModelContent, StoredEntry } from '@/types'

function modelContent(entry: StoredEntry): ModelContent {
  return entry.content as ModelContent
}

function actionVariant(action: ModelContent['action']) {
  switch (action) {
    case 'create':
      return 'success' as const
    case 'update':
      return 'info' as const
    case 'delete':
      return 'destructive' as const
  }
}

function preview(value: unknown): string {
  if (value === undefined) return 'Not recorded'
  if (typeof value === 'string') return truncate(value, 96)
  try {
    return truncate(JSON.stringify(value) ?? String(value), 96)
  } catch {
    return truncate(String(value), 96)
  }
}

function fieldCount(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return Object.keys(value).length
}

const columns: EntryColumn[] = [
  {
    key: 'action',
    header: 'Action',
    className: 'w-24',
    cell: (entry) => {
      const action = modelContent(entry).action
      return <Badge variant={actionVariant(action)}>{action}</Badge>
    },
  },
  {
    key: 'model',
    header: 'Model',
    primary: true,
    cell: (entry) => {
      const content = modelContent(entry)
      return (
        <div className="min-w-0">
          <div className="max-w-xl truncate font-mono text-xs font-medium" title={content.model}>
            {content.model}
          </div>
          <div className="mt-1 max-w-xl truncate font-mono text-2xs text-muted-foreground">
            {content.primaryKey
              ? `${content.primaryKey}=${preview(content.primaryKeyValue)}`
              : 'Primary key unavailable'}
          </div>
        </div>
      )
    },
  },
  {
    key: 'identifier',
    header: 'Identifier',
    className: 'w-40',
    cell: (entry) => (
      <span
        className="block max-w-40 truncate font-mono text-xs text-muted-foreground"
        title={preview(modelContent(entry).primaryKeyValue)}
      >
        {preview(modelContent(entry).primaryKeyValue)}
      </span>
    ),
  },
  {
    key: 'changes',
    header: 'Changes',
    className: 'w-24',
    cell: (entry) => {
      const count = fieldCount(modelContent(entry).dirty)
      return (
        <Badge variant="secondary">
          {count === null ? 'not captured' : `${count} ${count === 1 ? 'field' : 'fields'}`}
        </Badge>
      )
    },
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

export function ModelsPage() {
  const [searchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const [selected, setSelected] = useState<StoredEntry | null>(null)
  const tag = searchParams.get('tag')?.trim() || undefined
  const filters = useMemo<EntryFilters>(
    () => ({ type: 'model', tag, displayOnIndex: true, limit: 50 }),
    [tag]
  )
  const pagination = useCursorPagination(filters)
  const reload = pagination.reload
  const polling = useNewEntryPolling(pagination.entries, filters, status?.paused ?? true, revision)

  useEffect(() => {
    if (revision > 0) void reload()
  }, [reload, revision])

  const acceptNew = () => pagination.prepend(polling.accept())
  const content = selected ? modelContent(selected) : null
  const dirtyCount = content ? fieldCount(content.dirty) : null
  const hasAttributes = content
    ? Object.prototype.hasOwnProperty.call(content, 'attributes')
    : false
  const hasDirty = content ? Object.prototype.hasOwnProperty.call(content, 'dirty') : false

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold tracking-tight">Model mutations</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Review Lucid model creates, updates, and deletes with identifiers and captured changes.
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
        caption="Recorded Lucid model mutations"
        columns={columns}
        emptyDescription={
          tag
            ? `No model mutation carries the exact tag “${tag}”. Try another tag or clear the filter.`
            : 'Create, update, or delete a Lucid model while model events are enabled. Mutations appear here automatically.'
        }
        emptyTitle={tag ? 'No matching model mutations' : 'Waiting for a model mutation'}
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
          const entryContent = modelContent(entry)
          return `Inspect ${entryContent.action} of ${entryContent.model}`
        }}
        rows={pagination.entries}
      />

      <EntryDetailDrawer
        description={
          selected
            ? `${content?.primaryKey ?? 'Identifier'} ${preview(content?.primaryKeyValue)} · ${formatDateTime(selected.createdAt)}`
            : 'Model mutation detail'
        }
        meta={
          content && (
            <>
              <Badge variant={actionVariant(content.action)}>{content.action}</Badge>
              <Badge variant="secondary">
                {dirtyCount === null
                  ? 'changes not captured'
                  : `${dirtyCount} changed ${dirtyCount === 1 ? 'field' : 'fields'}`}
              </Badge>
            </>
          )
        }
        onOpenChange={(open) => !open && setSelected(null)}
        open={selected !== null}
        title={content ? truncate(content.model, 96) : 'Model mutation detail'}
      >
        {content && (
          <>
            <dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Model</dt>
                <dd className="mt-1 break-all font-mono text-sm">{content.model}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Primary key</dt>
                <dd className="mt-1 font-mono text-sm">{content.primaryKey ?? 'Not recorded'}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Primary key value</dt>
                <dd className="mt-1 max-h-24 overflow-auto break-all font-mono text-sm">
                  {preview(content.primaryKeyValue)}
                </dd>
              </div>
            </dl>

            {hasDirty ? (
              <JsonTree label="Dirty attributes" value={content.dirty} />
            ) : (
              <section className="rounded-lg border bg-muted/25 p-4">
                <h3 className="text-sm font-semibold">Dirty attributes were not captured</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Enable dirty value capture to inspect the fields changed by future model
                  mutations.
                </p>
              </section>
            )}

            {hasAttributes && <JsonTree label="Model attributes" value={content.attributes} />}
          </>
        )}
      </EntryDetailDrawer>
    </div>
  )
}
