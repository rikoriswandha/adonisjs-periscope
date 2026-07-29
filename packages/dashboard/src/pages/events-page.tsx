import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
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
          <div className="max-w-2xl truncate font-mono text-xs font-medium" title={content.name}>
            {truncate(content.name, 160)}
          </div>
          {content.className && (
            <div className="mt-1 max-w-2xl truncate text-2xs text-muted-foreground">
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
        <Badge variant={isClassEvent ? 'info' : 'secondary'}>
          {isClassEvent ? 'class event' : 'event'}
        </Badge>
      )
    },
  },
  {
    key: 'listeners',
    header: 'Listeners',
    className: 'w-24',
    cell: (entry) => {
      const count = eventContent(entry).listenerCount
      return count === undefined ? (
        <span className="text-xs text-muted-foreground">Unknown</span>
      ) : (
        count.toLocaleString()
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

function EventDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = eventContent(entry)

  return (
    <EntryDetailDrawer
      description={formatDateTime(entry.createdAt)}
      meta={
        <>
          <Badge variant={content.isClassEvent ? 'info' : 'secondary'}>
            {content.isClassEvent ? 'class event' : 'event'}
          </Badge>
          {content.listenerCount !== undefined && (
            <Badge variant="secondary">
              {content.listenerCount} {content.listenerCount === 1 ? 'listener' : 'listeners'}
            </Badge>
          )}
        </>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(content.name, 96)}
    >
      <dl className="grid gap-2.5 rounded-md border p-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Event name</dt>
          <dd className="mt-0.5 break-all font-mono text-sm">{content.name}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Identity</dt>
          <dd className="mt-0.5 font-mono text-sm">
            {content.isClassEvent ? 'Class event' : 'Named event'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Listeners</dt>
          <dd className="mt-0.5 font-mono text-sm">
            {content.listenerCount === undefined ? 'Not reported' : content.listenerCount}
          </dd>
        </div>
        {content.className && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Class identity</dt>
            <dd className="mt-0.5 break-all font-mono text-sm">{content.className}</dd>
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
