import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { EntryContent, StoredEntry } from '@/types'

type LogContent = EntryContent & {
  level: string
  levelNumber: number
  message: string | null
  context: Record<string, unknown>
  time: number | string | null
}

function logContent(entry: StoredEntry): LogContent {
  return entry.content as LogContent
}

function levelVariant(level: string) {
  switch (level.toLowerCase()) {
    case 'fatal':
    case 'error':
      return 'error' as const
    case 'warn':
    case 'warning':
      return 'warning' as const
    case 'info':
      return 'info' as const
    default:
      return 'secondary' as const
  }
}

function sourceTimestamp(value: LogContent['time']): string {
  if (value === null) return 'Not emitted by the logger'

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return String(value)

  return formatDateTime(parsed.toISOString())
}

const columns: EntryColumn[] = [
  {
    key: 'level',
    header: 'Level',
    className: 'w-24',
    cell: (entry) => {
      const level = logContent(entry).level
      return <Badge variant={levelVariant(level)}>{level}</Badge>
    },
  },
  {
    key: 'message',
    header: 'Message',
    primary: true,
    cell: (entry) => {
      const message = logContent(entry).message
      return (
        <span className="block max-w-2xl truncate text-sm font-medium" title={message ?? undefined}>
          {message ? truncate(message, 180) : 'No message'}
        </span>
      )
    },
  },
  {
    key: 'context',
    header: 'Context',
    className: 'w-28',
    cell: (entry) => {
      const count = Object.keys(logContent(entry).context).length
      return (
        <span className="text-xs text-muted-foreground">
          {count} {count === 1 ? 'key' : 'keys'}
        </span>
      )
    },
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36 text-right',
    cell: (entry) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground" title={entry.createdAt}>
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
]

function LogDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = logContent(entry)

  return (
    <EntryDetailDrawer
      description={`Recorded ${formatDateTime(entry.createdAt)}`}
      meta={<Badge variant={levelVariant(content.level)}>{content.level}</Badge>}
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(content.message ?? `${content.level} log entry`, 96)}
    >
      <dl className="grid gap-2.5 rounded-md border p-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Level</dt>
          <dd className="mt-0.5 font-mono text-sm">{content.level}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Source timestamp</dt>
          <dd className="mt-0.5 font-mono text-sm">{sourceTimestamp(content.time)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Message</dt>
          <dd className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm">
            {content.message ?? 'No message was emitted.'}
          </dd>
        </div>
      </dl>
      <JsonTree label="Log context" value={content.context} />
    </EntryDetailDrawer>
  )
}

export const logsEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Logs',
  description: 'Inspect application log records with their structured context and source time.',
  caption: 'Recorded application logs',
  columns,
  emptyTitle: (tag?: string) => (tag ? 'No matching logs' : 'Waiting for application logs'),
  emptyDescription: (tag?: string) =>
    tag
      ? `No log carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Write to the application logger. Records at enabled levels appear here automatically.',
  rowLabel: (entry: StoredEntry) => {
    const content = logContent(entry)
    return `Inspect ${content.level} log: ${truncate(content.message ?? 'No message', 80)}`
  },
  detailComponent: LogDetail,
}
