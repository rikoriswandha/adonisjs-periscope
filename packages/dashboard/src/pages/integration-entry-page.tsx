import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Panel, PanelBody, PanelHeader, StatusDot } from '@/components/instrument'
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
    cell: (entry) => <span className="num font-medium">{summary(entry)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    className: 'w-28',
    cell: (entry) => {
      const status = entry.content.status
      return typeof status === 'string' ? (
        <span className="num inline-flex items-center gap-1.5 text-xs text-ink-2">
          <StatusDot signal="neutral" />
          {status}
        </span>
      ) : null
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

function IntegrationEntryDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  return (
    <EntryDetailDrawer
      description="Recorded integration activity"
      meta={<span className="num text-xs text-ink-2">{entry.type.replaceAll('_', ' ')}</span>}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      open={open}
      tags={entry.tags}
      title={summary(entry)}
    >
      <Panel aria-labelledby={`integration-meta-${entry.uuid}`}>
        <PanelHeader id={`integration-meta-${entry.uuid}`} title="Entry metadata" />
        <PanelBody>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="micro-label">Entry UUID</dt>
              <dd className="num mt-1 truncate text-xs text-ink" title={entry.uuid}>
                {entry.uuid}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="micro-label">Batch ID</dt>
              <dd className="num mt-1 truncate text-xs text-ink" title={entry.batchId}>
                {entry.batchId}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="micro-label">Recorded</dt>
              <dd className="num mt-1 whitespace-nowrap text-xs text-ink">
                <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="micro-label">Sequence</dt>
              <dd className="num mt-1 truncate text-xs text-ink" title={entry.sequence}>
                {entry.sequence}
              </dd>
            </div>
          </dl>
        </PanelBody>
      </Panel>
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
