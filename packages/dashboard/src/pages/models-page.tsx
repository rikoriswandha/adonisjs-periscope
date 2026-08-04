import { ArrowUpRight } from 'lucide-react'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { StatusDot, type Signal } from '@/components/instrument'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { ModelContent, StoredEntry } from '@/types'

function modelContent(entry: StoredEntry): ModelContent {
  return entry.content as ModelContent
}

function actionSignal(action: ModelContent['action']): Signal {
  switch (action) {
    case 'create':
      return 'ok'
    case 'update':
      return 'info'
    case 'delete':
      return 'error'
  }
}

function preview(value: unknown): string {
  if (value === undefined) return 'Not recorded'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function ModelAction({ action }: { action: ModelContent['action'] }) {
  return (
    <span className="num inline-flex items-center gap-2 text-xs">
      <StatusDot signal={actionSignal(action)} />
      {action}
    </span>
  )
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
    cell: (entry) => <ModelAction action={modelContent(entry).action} />,
  },
  {
    key: 'model',
    header: 'Model',
    primary: true,
    cell: (entry) => {
      const content = modelContent(entry)
      return (
        <div className="min-w-0">
          <div className="num max-w-xl truncate text-xs font-medium" title={content.model}>
            {content.model}
          </div>
          <div
            className="num mt-1 max-w-xl truncate text-2xs text-ink-3"
            title={
              content.primaryKey
                ? `${content.primaryKey}=${preview(content.primaryKeyValue)}`
                : 'Primary key unavailable'
            }
          >
            {content.primaryKey
              ? `${content.primaryKey}=${truncate(preview(content.primaryKeyValue), 96)}`
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
        className="num block max-w-40 truncate text-xs text-ink-3"
        title={preview(modelContent(entry).primaryKeyValue)}
      >
        {truncate(preview(modelContent(entry).primaryKeyValue), 96)}
      </span>
    ),
  },
  {
    key: 'changes',
    header: 'Changes',
    className: 'w-28 text-right',
    cell: (entry) => {
      const count = fieldCount(modelContent(entry).dirty)
      return (
        <span className="num block whitespace-nowrap text-right text-xs text-ink-2">
          {count === null ? 'not captured' : `${count} ${count === 1 ? 'field' : 'fields'}`}
        </span>
      )
    },
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

function ModelDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = modelContent(entry)
  const dirtyCount = fieldCount(content.dirty)
  const hasAttributes = Object.prototype.hasOwnProperty.call(content, 'attributes')
  const hasDirty = Object.prototype.hasOwnProperty.call(content, 'dirty')
  return (
    <EntryDetailDrawer
      description={`${content.primaryKey ?? 'Identifier'} ${truncate(preview(content.primaryKeyValue), 96)} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <span className="flex flex-wrap items-center gap-3">
          <ModelAction action={content.action} />
          <span className="num text-xs text-ink-2">
            {dirtyCount === null
              ? 'changes not captured'
              : `${dirtyCount} changed ${dirtyCount === 1 ? 'field' : 'fields'}`}
          </span>
        </span>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(content.model, 96)}
    >
      <dl className="well grid gap-2.5 p-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Model</dt>
          <dd className="num mt-0.5 break-all text-sm">{content.model}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Primary key</dt>
          <dd className="num mt-0.5 truncate text-sm" title={content.primaryKey ?? 'Not recorded'}>
            {content.primaryKey ?? 'Not recorded'}
          </dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-ink-3">Primary key value</dt>
          <dd className="num mt-0.5 max-h-24 overflow-auto break-all text-sm">
            {preview(content.primaryKeyValue)}
          </dd>
        </div>
      </dl>
      {hasDirty ? (
        <JsonTree label="Dirty attributes" value={content.dirty} />
      ) : (
        <section className="well p-3">
          <h3 className="text-sm font-semibold">Dirty attributes were not captured</h3>
          <p className="mt-1 text-xs leading-5 text-ink-3">
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
