import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { StatusDot } from '@/components/instrument'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import type { SessionContent, StoredEntry } from '@/types'

function content(entry: StoredEntry): SessionContent {
  return entry.content as SessionContent
}

const columns: EntryColumn[] = [
  {
    key: 'operation',
    header: 'Lifecycle',
    primary: true,
    cell: (entry) => (
      <span className="num inline-flex items-center gap-2 text-xs">
        <StatusDot signal="neutral" />
        {content(entry).operation}
      </span>
    ),
  },
  {
    key: 'session',
    header: 'Session hash',
    className: 'w-72',
    cell: (entry) => (
      <span className="num block max-w-72 truncate text-xs" title={content(entry).sessionIdHash}>
        {content(entry).sessionIdHash}
      </span>
    ),
  },
  {
    key: 'state',
    header: 'State',
    className: 'w-28',
    cell: (entry) => {
      const value = content(entry)
      const state = value.fresh
        ? 'fresh'
        : value.modified
          ? 'modified'
          : value.readonly
            ? 'read-only'
            : 'unchanged'
      return (
        <span className="num inline-flex items-center gap-2 text-xs text-ink-2">
          <StatusDot signal="neutral" />
          {state}
        </span>
      )
    },
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36 text-right',
    cell: (entry) => (
      <span
        className="num block whitespace-nowrap text-right text-xs text-ink-3"
        title={formatDateTime(entry.createdAt)}
      >
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
]

function SessionDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const value = content(entry)
  return (
    <EntryDetailDrawer
      description={formatDateTime(entry.createdAt)}
      meta={
        <span className="num inline-flex items-center gap-2 text-xs">
          <StatusDot signal="neutral" />
          {value.operation}
        </span>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={`Session ${value.sessionIdHash}`}
    >
      <JsonTree label="Session lifecycle" value={value} />
    </EntryDetailDrawer>
  )
}

export const sessionsEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Sessions',
  description:
    'Follow session initiation, commit, and identifier migration without exposing raw IDs.',
  caption: 'Recorded session lifecycle events',
  columns,
  emptyTitle: (tag?: string) =>
    tag ? 'No matching session activity' : 'Waiting for session activity',
  emptyDescription: (tag?: string) =>
    tag
      ? `No session entry carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Enable the session watcher, then handle a request that uses an AdonisJS session.',
  rowLabel: (entry) => `${content(entry).operation} session ${content(entry).sessionIdHash}`,
  detailComponent: SessionDetail,
}
