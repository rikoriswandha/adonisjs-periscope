import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { DurationBadge } from '@/components/duration-badge'
import { JsonTree } from '@/components/json-tree'
import { StatusDot } from '@/components/instrument'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import type { RedisContent, StoredEntry } from '@/types'

function content(entry: StoredEntry): RedisContent {
  return entry.content as RedisContent
}

const columns: EntryColumn[] = [
  {
    key: 'command',
    header: 'Command',
    primary: true,
    cell: (entry) => {
      const command = content(entry).command
      return (
        <span className="num block max-w-2xl truncate font-medium" title={command}>
          {command}
        </span>
      )
    },
  },
  {
    key: 'arguments',
    header: 'Arguments',
    className: 'w-28 text-right',
    cell: (entry) => (
      <span className="num block text-right">{content(entry).argumentCount.toLocaleString()}</span>
    ),
  },
  {
    key: 'duration',
    header: 'Duration',
    className: 'w-28 text-right',
    cell: (entry) => <DurationBadge value={content(entry).durationMs} />,
  },
  {
    key: 'result',
    header: 'Result',
    className: 'w-28',
    cell: (entry) => {
      const failed = content(entry).error !== undefined
      return (
        <span className="num inline-flex items-center gap-2 text-xs">
          <StatusDot signal={failed ? 'error' : 'ok'} />
          {failed ? 'failed' : 'completed'}
        </span>
      )
    },
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36 text-right',
    cell: (entry) => (
      <span className="num block whitespace-nowrap text-right text-xs text-ink-3" title={formatDateTime(entry.createdAt)}>
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
]

function RedisDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const value = content(entry)
  return (
    <EntryDetailDrawer
      description={formatDateTime(entry.createdAt)}
      meta={
        <span className="flex flex-wrap items-center gap-3">
          <span className="num inline-flex items-center gap-2 text-xs">
            <StatusDot signal={value.error === undefined ? 'ok' : 'error'} />
            {value.error === undefined ? 'completed' : 'failed'}
          </span>
          <DurationBadge value={value.durationMs} />
        </span>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={value.command}
    >
      <JsonTree label="Redis command" value={value} />
    </EntryDetailDrawer>
  )
}

export const redisEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Redis operations',
  description: 'Inspect commands observed through the @adonisjs/redis diagnostics channel.',
  caption: 'Recorded Redis commands',
  columns,
  emptyTitle: (tag?: string) =>
    tag ? 'No matching Redis commands' : 'Waiting for Redis commands',
  emptyDescription: (tag?: string) =>
    tag
      ? `No Redis command carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Enable the Redis watcher, then execute a command through @adonisjs/redis.',
  rowLabel: (entry) => `${content(entry).command} Redis command`,
  detailComponent: RedisDetail,
}
