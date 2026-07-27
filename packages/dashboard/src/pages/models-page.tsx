import { ArrowUpRight } from 'lucide-react'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { ModelContent, StoredEntry } from '@/types'

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

function ModelDetail({ entry, onClose }: RegisteredEntryDetailProps) {
  const content = modelContent(entry)
  const dirtyCount = fieldCount(content.dirty)
  const hasAttributes = Object.prototype.hasOwnProperty.call(content, 'attributes')
  const hasDirty = Object.prototype.hasOwnProperty.call(content, 'dirty')
  return (
    <EntryDetailDrawer
      description={`${content.primaryKey ?? 'Identifier'} ${preview(content.primaryKeyValue)} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <>
          <Badge variant={actionVariant(content.action)}>{content.action}</Badge>
          <Badge variant="secondary">
            {dirtyCount === null
              ? 'changes not captured'
              : `${dirtyCount} changed ${dirtyCount === 1 ? 'field' : 'fields'}`}
          </Badge>
        </>
      }
      onOpenChange={(open) => !open && onClose()}
      open
      tags={entry.tags}
      title={truncate(content.model, 96)}
    >
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
            Enable dirty value capture to inspect the fields changed by future model mutations.
          </p>
        </section>
      )}
      {hasAttributes && <JsonTree label="Model attributes" value={content.attributes} />}
    </EntryDetailDrawer>
  )
}

export const modelsEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Model mutations',
  description:
    'Review Lucid model creates, updates, and deletes with identifiers and captured changes.',
  caption: 'Recorded Lucid model mutations',
  columns,
  emptyTitle: (tag?: string) =>
    tag ? 'No matching model mutations' : 'Waiting for a model mutation',
  emptyDescription: (tag?: string) =>
    tag
      ? `No model mutation carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Create, update, or delete a Lucid model while model events are enabled. Mutations appear here automatically.',
  rowLabel: (entry: StoredEntry) => {
    const content = modelContent(entry)
    return `Inspect ${content.action} of ${content.model}`
  },
  detailComponent: ModelDetail,
}
