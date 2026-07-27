import { ArrowUpRight } from 'lucide-react'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
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
      const count = valueCount(content.values)
      return (
        <div className="min-w-0">
          <div className="max-w-2xl truncate font-mono text-xs font-medium" title={serialized}>
            {serialized}
          </div>
          <div className="mt-1 text-2xs text-muted-foreground">
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

function DumpPageEffect() {
  useDumpOpenHeartbeat()
  return null
}

function DumpDetail({ entry, onClose }: RegisteredEntryDetailProps) {
  const content = dumpContent(entry)
  const count = valueCount(content.values)
  return (
    <EntryDetailDrawer
      description={`${callerLabel(content)} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <>
          <Badge variant="info">dump captured</Badge>
          <Badge variant="secondary">
            {count} {count === 1 ? 'value' : 'values'}
          </Badge>
        </>
      }
      onOpenChange={(open) => !open && onClose()}
      open
      tags={entry.tags}
      title={truncate(preview(content.values), 96)}
    >
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
            <dd className="mt-1 font-mono text-sm">{content.caller.column ?? 'Unavailable'}</dd>
          </div>
        </dl>
      ) : (
        <section className="rounded-lg border bg-muted/25 p-4">
          <h3 className="text-sm font-semibold">Application caller unavailable</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
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
