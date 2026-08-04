import { ArrowUpRight } from 'lucide-react'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { StatusDot } from '@/components/instrument'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { useDumpOpenHeartbeat } from '@/hooks/use-dump-open-heartbeat'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { DumpContent, StoredEntry } from '@/types'

function dumpContent(entry: StoredEntry): DumpContent {
  return entry.content as DumpContent
}

function valueCount(value: unknown): number {
  if (Array.isArray(value)) return value.length
  return value === undefined ? 0 : 1
}

function serialize(value: unknown): string {
  if (value === undefined) return 'No values recorded'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
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
      const serialized = serialize(content.values)
      const count = valueCount(content.values)
      return (
        <div className="min-w-0">
          <div className="num max-w-2xl truncate text-xs font-medium" title={serialized}>
            {truncate(serialized, 140)}
          </div>
          <div className="num mt-1 text-2xs text-ink-3">
            {count} {count === 1 ? 'value' : 'values'} captured
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
          className="num block max-w-72 truncate text-xs text-ink-3"
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
    className: 'w-20 text-right',
    cell: (entry) => (
      <span className="num block text-right text-xs">
        {valueCount(dumpContent(entry).values)} captured
      </span>
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

function DumpPageEffect() {
  useDumpOpenHeartbeat()
  return null
}

function DumpDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = dumpContent(entry)
  const count = valueCount(content.values)
  return (
    <EntryDetailDrawer
      description={`${callerLabel(content)} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <span className="flex flex-wrap items-center gap-3">
          <span className="num inline-flex items-center gap-2 text-xs">
            <StatusDot signal="info" />
            dump captured
          </span>
          <span className="num text-xs text-ink-2">
            {count} {count === 1 ? 'value' : 'values'}
          </span>
        </span>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(serialize(content.values), 96)}
    >
      {content.caller ? (
        <dl className="well grid gap-2.5 p-3 sm:grid-cols-3">
          <div className="min-w-0 sm:col-span-3">
            <dt className="text-xs text-ink-3">Source file</dt>
            <dd className="num mt-0.5 max-h-24 overflow-auto break-all text-sm">
              {content.caller.file}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Line</dt>
            <dd className="num mt-0.5 text-sm">{content.caller.line}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Column</dt>
            <dd className="num mt-0.5 text-sm">{content.caller.column ?? 'Unavailable'}</dd>
          </div>
        </dl>
      ) : (
        <section className="well p-3">
          <h3 className="text-sm font-semibold">Application caller unavailable</h3>
          <p className="mt-1 text-xs leading-5 text-ink-3">
            Periscope could not identify an application frame above this dump call. The captured
            values remain available below.
          </p>
        </section>
      )}
      <JsonTree label="Dumped values" value={content.values} />
    </EntryDetailDrawer>
  )
}

export const dumpsEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Application dumps',
  description: 'Inspect serialized values sent through dump() with their application call site.',
  caption: 'Recorded application dumps',
  columns,
  emptyTitle: (tag?: string) => (tag ? 'No matching dumps' : 'Waiting for a dump'),
  emptyDescription: (tag?: string) =>
    tag
      ? `No dump carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Call dump() in application code while this page is open. Serialized values appear here automatically.',
  rowLabel: (entry: StoredEntry) => `Inspect dump from ${callerLabel(dumpContent(entry))}`,
  detailComponent: DumpDetail,
  pageEffect: DumpPageEffect,
}
