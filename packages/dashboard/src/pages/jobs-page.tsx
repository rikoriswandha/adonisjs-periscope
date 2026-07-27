import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { DurationBadge } from '@/components/duration-badge'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { JobContent, ScheduleContent, StoredEntry } from '@/types'

function JobDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = entry.content as JobContent
  return (
    <EntryDetailDrawer
      description={`${content.queue} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <>
          <Badge variant={content.status === 'failed' ? 'error' : 'success'}>
            {content.status}
          </Badge>
          {content.durationMs !== undefined && <DurationBadge value={content.durationMs} />}
        </>
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
      meta={<Badge variant="info">scheduled</Badge>}
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
          <div className="truncate font-medium">{content.name ?? content.jobId}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{content.queue}</div>
        </div>
      )
    },
  },
  {
    key: 'status',
    header: 'Status',
    cell: (entry) => {
      const status = (entry.content as JobContent).status
      return <Badge variant={status === 'failed' ? 'error' : 'success'}>{status}</Badge>
    },
  },
  {
    key: 'duration',
    header: 'Duration',
    cell: (entry) => {
      const duration = (entry.content as JobContent).durationMs
      return duration === undefined ? '—' : <DurationBadge value={duration} />
    },
  },
  {
    key: 'adapter',
    header: 'Adapter',
    cell: (entry) => <span className="font-mono text-xs">{String(entry.content.adapter)}</span>,
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

const scheduleColumns: EntryColumn[] = [
  {
    key: 'schedule',
    header: 'Scheduled job',
    primary: true,
    cell: (entry) => {
      const content = entry.content as ScheduleContent
      return (
        <div className="min-w-0">
          <div className="truncate font-medium">{content.name ?? content.jobId}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{content.queue}</div>
        </div>
      )
    },
  },
  {
    key: 'scheduledAt',
    header: 'Scheduled for',
    cell: (entry) => {
      const value = (entry.content as ScheduleContent).scheduledAt
      return value ? formatDateTime(value) : '—'
    },
  },
  {
    key: 'adapter',
    header: 'Adapter',
    cell: (entry) => <span className="font-mono text-xs">{String(entry.content.adapter)}</span>,
  },
  {
    key: 'when',
    header: 'Observed',
    className: 'text-right',
    cell: (entry) => formatRelativeTime(entry.createdAt),
  },
]

export const jobsEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Jobs',
  description: 'Inspect completed and failed jobs reported by configured queue adapters.',
  caption: 'Recorded job lifecycles',
  columns: jobColumns,
  emptyTitle: () => 'Waiting for queue jobs',
  emptyDescription: () => 'Enable the job_schedule watcher and configure a queue adapter.',
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
  emptyTitle: () => 'Waiting for scheduled work',
  emptyDescription: () => 'Schedule a job through a configured queue adapter.',
  rowLabel: (entry: StoredEntry) => {
    const content = entry.content as ScheduleContent
    return `scheduled job ${truncate(content.name ?? content.jobId, 80)}`
  },
  detailComponent: ScheduleDetail,
}
