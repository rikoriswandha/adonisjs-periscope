import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
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
        <span className="num block max-w-2xl truncate text-xs font-medium" title={channel}>
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
      return (
        <span
          className="num block max-w-48 truncate text-xs text-ink-2"
          title={event ?? 'Not reported'}
        >
          {event ?? 'Not reported'}
        </span>
      )
    },
  },
  {
    key: 'time',
    header: 'Time',
    className: 'w-36 text-right',
    cell: (entry) => (
      <span className="num block whitespace-nowrap text-right text-xs text-ink-3" title={entry.createdAt}>
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
      meta={<span className="num text-xs text-ink-2">broadcast</span>}
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(value.channel, 96)}
    >
      <dl className="well grid gap-2.5 p-3 sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-ink-3">Channel</dt>
          <dd className="num mt-0.5 break-all text-sm">{value.channel}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-ink-3">Event</dt>
          <dd className="num mt-0.5 break-all text-sm">
            {value.event ?? 'Not reported by Transmit'}
          </dd>
        </div>
      </dl>

      {value.payloadSummary === undefined ? (
        <div className="well p-3 text-xs text-ink-3">
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
