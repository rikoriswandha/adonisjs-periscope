import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import type { StoredEntry } from '@/types'

function summary(entry: StoredEntry): string {
  const content = entry.content
  const candidate = content.operation ?? content.event ?? content.name ?? content.action ?? content.status
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : entry.type.replaceAll('_', ' ')
}

const columns: EntryColumn[] = [
  {
    key: 'activity',
    header: 'Activity',
    primary: true,
    cell: (entry) => <span className="font-medium">{summary(entry)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    className: 'w-28',
    cell: (entry) => {
      const status = entry.content.status
      return typeof status === 'string' ? <Badge variant="secondary">{status}</Badge> : null
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

function IntegrationEntryDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  return (
    <EntryDetailDrawer
      description={formatDateTime(entry.createdAt)}
      meta={<Badge variant="secondary">{entry.type.replaceAll('_', ' ')}</Badge>}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      open={open}
      tags={entry.tags}
      title={summary(entry)}
    >
      <JsonTree label="Recorded content" value={entry.content} />
    </EntryDetailDrawer>
  )
}

export function createIntegrationEntryTypeImplementation({
  heading,
  description,
}: {
  heading: string
  description: string
}): EntryTypeImplementation {
  return {
    heading,
    description,
    caption: `Recorded ${heading.toLocaleLowerCase()} activity`,
    columns,
    emptyTitle: (tag?: string) => (tag ? `No matching ${heading.toLocaleLowerCase()}` : `Waiting for ${heading.toLocaleLowerCase()}`),
    emptyDescription: (tag?: string) =>
      tag
        ? `No entry carries the exact tag “${tag}”. Try another tag or clear the filter.`
        : `Enable the corresponding watcher, then exercise the integration in your application.`,
    rowLabel: (entry) => `${heading}: ${summary(entry)}`,
    detailComponent: IntegrationEntryDetail,
  }
}
