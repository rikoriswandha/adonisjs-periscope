import { ArrowUpRight } from 'lucide-react'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { StatusDot, type Signal } from '@/components/instrument'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { CacheContent, StoredEntry } from '@/types'

function cacheContent(entry: StoredEntry): CacheContent {
  return entry.content as CacheContent
}

function operationSignal(operation: CacheContent['operation']): Signal {
  switch (operation) {
    case 'hit':
      return 'ok'
    case 'miss':
      return 'warn'
    case 'set':
    case 'delete':
    case 'clear':
      return 'neutral'
  }
}

function CacheOperation({ operation }: { operation: CacheContent['operation'] }) {
  return (
    <span className="num inline-flex items-center gap-2 text-xs">
      <StatusDot signal={operationSignal(operation)} />
      {operation}
    </span>
  )
}

const columns: EntryColumn[] = [
  {
    key: 'operation',
    header: 'Operation',
    className: 'w-24',
    cell: (entry) => <CacheOperation operation={cacheContent(entry).operation} />,
  },
  {
    key: 'key',
    header: 'Cache key',
    primary: true,
    cell: (entry) => {
      const content = cacheContent(entry)
      return (
        <div className="min-w-0">
          <div
            className="num max-w-2xl truncate text-xs font-medium"
            title={content.key ?? 'Entire store'}
          >
            {content.key ? truncate(content.key, 140) : 'Entire store'}
          </div>
          {content.graced && (
            <span className="num mt-1.5 inline-flex items-center gap-2 text-xs">
              <StatusDot signal="warn" />
              graced response
            </span>
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
      <span className="num block max-w-32 truncate text-xs text-ink-3" title={cacheContent(entry).store}>
        {cacheContent(entry).store}
      </span>
    ),
  },
  {
    key: 'layer',
    header: 'Layer',
    className: 'w-20',
    cell: (entry) => (
      <span className="num text-xs text-ink-2">{cacheContent(entry).layer?.toUpperCase() ?? 'all'}</span>
    ),
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36 text-right',
    cell: (entry) => (
      <span className="num block whitespace-nowrap text-right text-xs text-ink-3" title={entry.createdAt}>
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
  {
    key: 'open',
    header: '',
    className: 'w-10 text-right',
    cell: () => (
      <ArrowUpRight aria-hidden="true" className="ms-auto size-4 text-ink-3" />
    ),
  },
]

function CacheDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = cacheContent(entry)
  const hasCapturedValue = Object.prototype.hasOwnProperty.call(content, 'value')
  return (
    <EntryDetailDrawer
      description={`${content.store} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <span className="flex flex-wrap items-center gap-3">
          <CacheOperation operation={content.operation} />
          <span className="num text-xs text-ink-2">{content.layer?.toUpperCase() ?? 'all layers'}</span>
          {content.graced && (
            <span className="num inline-flex items-center gap-2 text-xs">
              <StatusDot signal="warn" />
              graced response
            </span>
          )}
        </span>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(content.key ?? `Clear ${content.store}`, 96)}
    >
      <dl className="well grid gap-2.5 p-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Store</dt>
          <dd className="num mt-0.5 break-all text-sm">{content.store}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Layer</dt>
          <dd className="num mt-0.5 text-sm">{content.layer?.toUpperCase() ?? 'All layers'}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-ink-3">Cache key</dt>
          <dd className="num mt-0.5 max-h-24 overflow-auto break-all text-sm">
            {content.key ?? 'Operation applies to the entire store'}
          </dd>
        </div>
      </dl>
      {hasCapturedValue ? (
        <JsonTree label="Captured cache value" value={content.value} />
      ) : (
        <section className="well p-3">
          <h3 className="text-sm font-semibold">No value payload recorded</h3>
          <p className="mt-1 text-xs leading-5 text-ink-3">
            Values are omitted for this operation or value capture is disabled. Keys and operation
            metadata remain available.
          </p>
        </section>
      )}
    </EntryDetailDrawer>
  )
}

export const cacheEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Cache operations',
  description: 'Follow hits, misses, writes, deletions, and clears across stores and cache layers.',
  caption: 'Recorded cache operations',
  columns,
  emptyTitle: (tag?: string) =>
    tag ? 'No matching cache operations' : 'Waiting for cache activity',
  emptyDescription: (tag?: string) =>
    tag
      ? `No cache operation carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Read from or write to the application cache. Operations appear here automatically when cache events are enabled.',
  rowLabel: (entry: StoredEntry) => {
    const content = cacheContent(entry)
    return `Inspect cache ${content.operation}: ${content.key ?? content.store}`
  },
  detailComponent: CacheDetail,
}
