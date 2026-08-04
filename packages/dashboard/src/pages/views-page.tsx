import { Network } from 'lucide-react'
import { Link } from 'react-router-dom'

import { DurationBadge } from '@/components/duration-badge'
import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { Button } from '@/components/ui/button'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatDuration, formatRelativeTime, truncate } from '@/lib/format'
import type { StoredEntry, ViewContent } from '@/types'

function viewContent(entry: StoredEntry): ViewContent {
  return entry.content as ViewContent
}

const columns: EntryColumn[] = [
  {
    key: 'template',
    header: 'Template',
    primary: true,
    cell: (entry) => {
      const template = viewContent(entry).template
      return (
        <span className="num block max-w-3xl truncate text-xs font-medium" title={template}>
          {template}
        </span>
      )
    },
  },
  {
    key: 'duration',
    header: 'Duration',
    className: 'w-28 text-right',
    cell: (entry) => <DurationBadge value={viewContent(entry).durationMs} />,
  },
  {
    key: 'when',
    header: 'Time',
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

function ViewDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = viewContent(entry)
  const dataKeys = content.dataKeys

  return (
    <EntryDetailDrawer
      description={`Edge template render · ${formatDateTime(entry.createdAt)}`}
      meta={<DurationBadge value={content.durationMs} />}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(content.template, 96)}
    >
      <dl className="well grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Template</dt>
          <dd className="num mt-1 break-all text-sm font-medium">{content.template}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Duration</dt>
          <dd className="num mt-1 text-sm">{formatDuration(content.durationMs)}</dd>
        </div>
      </dl>

      <section aria-labelledby="view-data-keys-title" className="space-y-2.5">
        <div>
          <h3 className="text-sm font-semibold" id="view-data-keys-title">
            Data keys
          </h3>
          <p className="mt-1 text-xs leading-5 text-ink-3">
            Top-level names only. Render data values are never retained.
          </p>
        </div>
        {dataKeys === undefined ? (
          <p className="well p-3 text-sm text-ink-3">
            Data key capture was disabled for this render.
          </p>
        ) : dataKeys.length === 0 ? (
          <p className="well p-3 text-sm text-ink-3">
            No top-level data keys were passed to this template.
          </p>
        ) : (
          <div className="well flex min-w-0 flex-wrap gap-x-4 gap-y-2 p-3">
            {dataKeys.map((key) => (
              <span className="num max-w-full truncate text-xs text-ink-2" key={key} title={key}>
                {key}
              </span>
            ))}
          </div>
        )}
      </section>

      <Button
        render={<Link to={`/requests/${encodeURIComponent(entry.batchId)}`} />}
        variant="outline"
      >
        <Network aria-hidden="true" />
        Open batch timeline
      </Button>
    </EntryDetailDrawer>
  )
}

export const viewsEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Views',
  description: 'Inspect Edge template render timing and the top-level data keys supplied to it.',
  caption: 'Recorded Edge template renders',
  columns,
  emptyTitle: (tag?: string) => (tag ? 'No matching views' : 'Waiting for a template render'),
  emptyDescription: (tag?: string) =>
    tag
      ? `No view render carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Render an Edge template while the view watcher is enabled. It will appear here automatically.',
  rowLabel: (entry) => `Inspect rendered view ${viewContent(entry).template}`,
  detailComponent: ViewDetail,
}
