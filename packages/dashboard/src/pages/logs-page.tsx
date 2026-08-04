import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { StatusDot, type Signal } from '@/components/instrument'
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

function levelSignal(level: string): Signal {
  switch (level.toLowerCase()) {
    case 'fatal':
    case 'error':
      return 'error'
    case 'warn':
    case 'warning':
      return 'warn'
    case 'info':
      return 'info'
    case 'debug':
    case 'trace':
    default:
      return 'neutral'
  }
}

function LogLevel({ level }: { level: string }) {
  return (
    <span className="num inline-flex items-center gap-2 text-xs">
      <StatusDot signal={levelSignal(level)} />
      {level}
    </span>
  )
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
    cell: (entry) => <LogLevel level={logContent(entry).level} />,
  },
  {
    key: 'message',
    header: 'Message',
    primary: true,
    cell: (entry) => {
      const message = logContent(entry).message
      return (
        <span className="num block max-w-2xl truncate text-sm font-medium" title={message ?? undefined}>
          {message ? truncate(message, 180) : 'No message'}
        </span>
      )
    },
  },
  {
    key: 'context',
    header: 'Context',
    className: 'w-28 text-right',
    cell: (entry) => {
      const count = Object.keys(logContent(entry).context).length
      return (
        <span className="num block text-right text-xs text-ink-3">
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
      <span className="num whitespace-nowrap text-xs text-ink-3" title={entry.createdAt}>
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
      meta={<LogLevel level={content.level} />}
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(content.message ?? `${content.level} log entry`, 96)}
    >
      <dl className="well grid gap-2.5 p-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-ink-3">Level</dt>
          <dd className="mt-0.5">
            <LogLevel level={content.level} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Source timestamp</dt>
          <dd className="num mt-0.5 truncate text-sm" title={sourceTimestamp(content.time)}>
            {sourceTimestamp(content.time)}
          </dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-ink-3">Message</dt>
          <dd className="num mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm">
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
