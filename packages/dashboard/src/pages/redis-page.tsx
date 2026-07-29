import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { DurationBadge } from '@/components/duration-badge'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
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
    cell: (entry) => <span className="font-mono font-medium">{content(entry).command}</span>,
  },
  {
    key: 'arguments',
    header: 'Arguments',
    cell: (entry) => content(entry).argumentCount.toLocaleString(),
  },
  {
    key: 'duration',
    header: 'Duration',
    cell: (entry) => <DurationBadge value={content(entry).durationMs} />,
  },
  {
    key: 'result',
    header: 'Result',
    cell: (entry) => (
      <Badge variant={content(entry).error === undefined ? 'success' : 'error'}>
        {content(entry).error === undefined ? 'completed' : 'failed'}
      </Badge>
    ),
  },
  {
    key: 'when',
    header: 'When',
    className: 'text-right',
    cell: (entry) => (
      <span title={formatDateTime(entry.createdAt)}>{formatRelativeTime(entry.createdAt)}</span>
    ),
  },
]

function RedisDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const value = content(entry)
  return (
    <EntryDetailDrawer
      description={formatDateTime(entry.createdAt)}
      meta={<DurationBadge value={value.durationMs} />}
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
