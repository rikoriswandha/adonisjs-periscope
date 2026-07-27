import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
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
    cell: (entry) => <Badge variant="secondary">{content(entry).operation}</Badge>,
  },
  {
    key: 'session',
    header: 'Session hash',
    cell: (entry) => <span className="font-mono text-xs">{content(entry).sessionIdHash}</span>,
  },
  {
    key: 'state',
    header: 'State',
    cell: (entry) => {
      const value = content(entry)
      return value.fresh
        ? 'fresh'
        : value.modified
          ? 'modified'
          : value.readonly
            ? 'read-only'
            : 'unchanged'
    },
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

function SessionDetail({ entry, onClose }: RegisteredEntryDetailProps) {
  const value = content(entry)
  return (
    <EntryDetailDrawer
      description={formatDateTime(entry.createdAt)}
      meta={<Badge variant="secondary">{value.operation}</Badge>}
      onOpenChange={(open) => !open && onClose()}
      open
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
  emptyTitle: () => 'Waiting for session activity',
  emptyDescription: () =>
    'Enable the session watcher, then handle a request that uses an AdonisJS session.',
  rowLabel: (entry) => `${content(entry).operation} session ${content(entry).sessionIdHash}`,
  detailComponent: SessionDetail,
}
