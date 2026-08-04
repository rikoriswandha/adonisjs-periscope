import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { StatusDot } from '@/components/instrument'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { EntryContent, StoredEntry } from '@/types'

type EventContent = EntryContent & {
  name: string
  payload: unknown
  isClassEvent: boolean
  className?: string
  listenerCount?: number
}

function eventContent(entry: StoredEntry): EventContent {
  return entry.content as EventContent
}

const columns: EntryColumn[] = [
  {
    key: 'event',
    header: 'Event',
    primary: true,
    cell: (entry) => {
      const content = eventContent(entry)
      return (
        <div className="min-w-0">
          <div className="num max-w-2xl truncate text-xs font-medium" title={content.name}>
            {truncate(content.name, 160)}
          </div>
          {content.className && (
            <div className="num mt-1 max-w-2xl truncate text-2xs text-ink-3" title={content.className}>
              {content.className}
            </div>
          )}
        </div>
      )
    },
  },
  {
    key: 'kind',
    header: 'Kind',
    className: 'w-28',
    cell: (entry) => {
      const isClassEvent = eventContent(entry).isClassEvent
      return (
        <span className="num inline-flex items-center gap-2 text-xs">
          <StatusDot signal="neutral" />
          {isClassEvent ? 'class event' : 'event'}
        </span>
      )
    },
  },
  {
    key: 'listeners',
    header: 'Listeners',
    className: 'w-24 text-right',
    cell: (entry) => {
      const count = eventContent(entry).listenerCount
      return (
        <span className="num block text-right text-xs text-ink-2">
          {count === undefined ? 'Unknown' : count.toLocaleString()}
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

function EventDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = eventContent(entry)

  return (
    <EntryDetailDrawer
      description={formatDateTime(entry.createdAt)}
      meta={
        <span className="flex flex-wrap items-center gap-3">
          <span className="num inline-flex items-center gap-2 text-xs">
            <StatusDot signal="neutral" />
            {content.isClassEvent ? 'class event' : 'event'}
          </span>
          {content.listenerCount !== undefined && (
            <span className="num text-xs text-ink-2">
              {content.listenerCount} {content.listenerCount === 1 ? 'listener' : 'listeners'}
            </span>
          )}
        </span>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(content.name, 96)}
    >
      <dl className="well grid gap-2.5 p-3 sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-ink-3">Event name</dt>
          <dd className="num mt-0.5 break-all text-sm">{content.name}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Identity</dt>
          <dd className="num mt-0.5 text-sm">
            {content.isClassEvent ? 'Class event' : 'Named event'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Listeners</dt>
          <dd className="num mt-0.5 text-sm">
            {content.listenerCount === undefined ? 'Not reported' : content.listenerCount}
          </dd>
        </div>
        {content.className && (
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-xs text-ink-3">Class identity</dt>
            <dd className="num mt-0.5 break-all text-sm">{content.className}</dd>
          </div>
        )}
      </dl>
      <JsonTree label="Event payload" value={content.payload} />
    </EntryDetailDrawer>
  )
}

export const eventsEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Events',
  description: 'Inspect dispatched application events, their identity, listeners, and payloads.',
  caption: 'Recorded application events',
  columns,
  emptyTitle: (tag?: string) => (tag ? 'No matching events' : 'Waiting for application events'),
  emptyDescription: (tag?: string) =>
    tag
      ? `No event carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Dispatch an application event. Events appear here automatically when event recording is enabled.',
  rowLabel: (entry: StoredEntry) => `Inspect event: ${eventContent(entry).name}`,
  detailComponent: EventDetail,
}
