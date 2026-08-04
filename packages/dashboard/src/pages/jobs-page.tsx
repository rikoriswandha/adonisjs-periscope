import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { DurationBadge } from '@/components/duration-badge'
import { JsonTree } from '@/components/json-tree'
import { StatusDot } from '@/components/instrument'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { JobContent, ScheduleContent, StoredEntry } from '@/types'

function JobDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = entry.content as JobContent
  return (
    <EntryDetailDrawer
      description={`${content.queue} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <span className="flex flex-wrap items-center gap-3">
          <span className="num inline-flex items-center gap-2 text-xs">
            <StatusDot signal={content.status === 'failed' ? 'error' : 'ok'} />
            {content.status}
          </span>
          {content.durationMs !== undefined && <DurationBadge value={content.durationMs} />}
        </span>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={content.name ?? content.jobId}
    >
      <JsonTree label="Job lifecycle" value={content} />
    </EntryDetailDrawer>
  )
}

function ScheduleDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = entry.content as ScheduleContent
  return (
    <EntryDetailDrawer
      description={`${content.queue} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <span className="num inline-flex items-center gap-2 text-xs">
          <StatusDot signal="info" />
          scheduled
        </span>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={content.name ?? content.jobId}
    >
      <JsonTree label="Schedule lifecycle" value={content} />
    </EntryDetailDrawer>
  )
}

const jobColumns: EntryColumn[] = [
  {
    key: 'job',
    header: 'Job',
    primary: true,
    cell: (entry) => {
      const content = entry.content as JobContent
      return (
        <div className="min-w-0">
          <div className="num truncate font-medium" title={content.name ?? content.jobId}>
            {content.name ?? content.jobId}
          </div>
          <div className="num truncate text-xs text-ink-3" title={content.queue}>
            {content.queue}
          </div>
        </div>
      )
    },
  },
  {
    key: 'status',
    header: 'Status',
    className: 'w-28',
    cell: (entry) => {
      const status = (entry.content as JobContent).status
      return (
        <span className="num inline-flex items-center gap-2 text-xs">
          <StatusDot signal={status === 'failed' ? 'error' : 'ok'} />
          {status}
        </span>
      )
    },
  },
  {
    key: 'duration',
    header: 'Duration',
    className: 'w-28 text-right',
    cell: (entry) => {
      const duration = (entry.content as JobContent).durationMs
      return duration === undefined ? <span className="num text-ink-3">—</span> : <DurationBadge value={duration} />
    },
  },
  {
    key: 'adapter',
    header: 'Adapter',
    className: 'w-28',
    cell: (entry) => (
      <span className="num block max-w-28 truncate text-xs" title={String(entry.content.adapter)}>
        {String(entry.content.adapter)}
      </span>
    ),
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36 text-right',
    cell: (entry) => (
      <span className="num whitespace-nowrap text-xs text-ink-3" title={formatDateTime(entry.createdAt)}>
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
]

const scheduleColumns: EntryColumn[] = [
  {
    key: 'schedule',
    header: 'Scheduled job',
    primary: true,
    cell: (entry) => {
      const content = entry.content as ScheduleContent
      return (
        <div className="min-w-0">
          <div className="num truncate font-medium" title={content.name ?? content.jobId}>
            {content.name ?? content.jobId}
          </div>
          <div className="num truncate text-xs text-ink-3" title={content.queue}>
            {content.queue}
          </div>
        </div>
      )
    },
  },
  {
    key: 'scheduledAt',
    header: 'Scheduled for',
    className: 'w-44',
    cell: (entry) => {
      const value = (entry.content as ScheduleContent).scheduledAt
      return (
        <span className="num block whitespace-nowrap text-xs" title={value}>
          {value ? formatDateTime(value) : '—'}
        </span>
      )
    },
  },
  {
    key: 'adapter',
    header: 'Adapter',
    className: 'w-28',
    cell: (entry) => (
      <span className="num block max-w-28 truncate text-xs" title={String(entry.content.adapter)}>
        {String(entry.content.adapter)}
      </span>
    ),
  },
  {
    key: 'when',
    header: 'Observed',
    className: 'w-36 text-right',
    cell: (entry) => (
      <span className="num whitespace-nowrap text-xs text-ink-3" title={formatDateTime(entry.createdAt)}>
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
]

export const jobsEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Jobs',
  description: 'Inspect completed and failed jobs reported by configured queue adapters.',
  caption: 'Recorded job lifecycles',
  columns: jobColumns,
  emptyTitle: (tag?: string) => (tag ? 'No matching jobs' : 'Waiting for completed queue work'),
  emptyDescription: (tag?: string) =>
    tag
      ? `No job carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Run a job through a configured queue adapter while the jobs watcher is enabled. Completed and failed executions appear here.',
  rowLabel: (entry: StoredEntry) => {
    const content = entry.content as JobContent
    return `${content.status} job ${truncate(content.name ?? content.jobId, 80)}`
  },
  detailComponent: JobDetail,
}

export const schedulesEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Schedules',
  description: 'See delayed and scheduled work before a worker begins execution.',
  caption: 'Recorded schedule lifecycles',
  columns: scheduleColumns,
  emptyTitle: (tag?: string) =>
    tag ? 'No matching scheduled work' : 'Waiting for delayed or scheduled work',
  emptyDescription: (tag?: string) =>
    tag
      ? `No scheduled job carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Dispatch a delayed or scheduled job through a configured queue adapter. It appears here before a worker begins execution.',
  rowLabel: (entry: StoredEntry) => {
    const content = entry.content as ScheduleContent
    return `scheduled job ${truncate(content.name ?? content.jobId, 80)}`
  },
  detailComponent: ScheduleDetail,
}
