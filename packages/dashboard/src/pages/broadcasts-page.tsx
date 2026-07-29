import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { BroadcastContent, StoredEntry } from '@/types'

function content(entry: StoredEntry): BroadcastContent {
  return entry.content as BroadcastContent
}

const columns: EntryColumn[] = [
  {
    key: 'channel',
    header: 'Channel',
    primary: true,
    cell: (entry) => {
      const channel = content(entry).channel
      return (
        <span className="block max-w-2xl truncate font-mono text-xs font-medium" title={channel}>
          {truncate(channel, 160)}
        </span>
      )
    },
  },
  {
    key: 'event',
    header: 'Event',
    className: 'w-48',
    cell: (entry) => {
      const event = content(entry).event
      return event === undefined ? (
        <span className="text-xs text-muted-foreground">Not reported</span>
      ) : (
        <span className="font-mono text-xs">{event}</span>
      )
    },
  },
  {
    key: 'time',
    header: 'Time',
    className: 'w-36 text-right',
    cell: (entry) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground" title={entry.createdAt}>
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
]

function BroadcastDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const value = content(entry)

  return (
    <EntryDetailDrawer
      description={formatDateTime(entry.createdAt)}
      meta={<Badge variant="info">broadcast</Badge>}
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(value.channel, 96)}
    >
      <dl className="grid gap-2.5 rounded-md border p-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Channel</dt>
          <dd className="mt-0.5 break-all font-mono text-sm">{value.channel}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Event</dt>
          <dd className="mt-0.5 break-all font-mono text-sm">
            {value.event ?? 'Not reported by Transmit'}
          </dd>
        </div>
      </dl>

      {value.payloadSummary === undefined ? (
        <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          No payload summary was captured for this broadcast.
        </div>
      ) : (
        <JsonTree label="Payload summary" value={value.payloadSummary} />
      )}
    </EntryDetailDrawer>
  )
}

export const broadcastsEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Broadcasts',
  description: 'Inspect messages published through @adonisjs/transmit and their channel metadata.',
  caption: 'Recorded Transmit broadcasts',
  columns,
  emptyTitle: (tag?: string) =>
    tag ? 'No matching broadcasts' : 'Waiting for Transmit broadcasts',
  emptyDescription: (tag?: string) =>
    tag
      ? `No broadcast carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Enable the Transmit watcher, then publish a broadcast through @adonisjs/transmit.',
  rowLabel: (entry) => `Inspect broadcast on ${content(entry).channel}`,
  detailComponent: BroadcastDetail,
}
