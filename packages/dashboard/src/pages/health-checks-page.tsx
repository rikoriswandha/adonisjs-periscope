import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { DurationBadge } from '@/components/duration-badge'
import { JsonTree } from '@/components/json-tree'
import { StatusDot, type Signal } from '@/components/instrument'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
import type { HealthCheckContent, HealthCheckResult, StoredEntry } from '@/types'

function content(entry: StoredEntry): HealthCheckContent {
  return entry.content as HealthCheckContent
}

function healthSignal(status: HealthCheckResult['status']): Signal {
  switch (status) {
    case 'ok':
      return 'ok'
    case 'warning':
      return 'warn'
    case 'error':
      return 'error'
    case 'unknown':
      return 'neutral'
  }
}

function HealthStatus({ status }: { status: HealthCheckResult['status'] }) {
  return (
    <span className="num inline-flex items-center gap-2 text-xs">
      <StatusDot signal={healthSignal(status)} />
      {status}
    </span>
  )
}

function failingCount(value: HealthCheckContent): number {
  return value.checks.filter((check) => check.status === 'error').length
}

const columns: EntryColumn[] = [
  {
    key: 'status',
    header: 'Status',
    primary: true,
    className: 'w-28',
    cell: (entry) => <HealthStatus status={content(entry).status} />,
  },
  {
    key: 'failing',
    header: 'Failing checks',
    className: 'w-28 text-right',
    cell: (entry) => {
      const count = failingCount(content(entry))
      return (
        <span className={`num block text-right ${count > 0 ? 'text-sig-error' : 'text-ink-2'}`}>
          {count}
        </span>
      )
    },
  },
  {
    key: 'checks',
    header: 'Checks',
    className: 'w-24 text-right',
    cell: (entry) => (
      <span className="num block text-right">{content(entry).checks.length.toLocaleString()}</span>
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

function CheckResultsTable({ checks }: { checks: HealthCheckResult[] }) {
  return (
    <section aria-labelledby="health-check-results-heading" className="well overflow-hidden">
      <div className="border-b border-edge px-3 py-2">
        <h3 className="micro-label" id="health-check-results-heading">
          Check results
        </h3>
      </div>
      <div className="overflow-x-auto">
        <Table className="min-w-[34rem] text-xs">
          <TableCaption className="sr-only">Individual health check results</TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="micro-label px-2.5" scope="col" style={{ height: 'var(--row-h)' }}>
                Check
              </TableHead>
              <TableHead
                className="micro-label w-24 px-2.5"
                scope="col"
                style={{ height: 'var(--row-h)' }}
              >
                Status
              </TableHead>
              <TableHead
                className="micro-label w-24 px-2.5 text-right"
                scope="col"
                style={{ height: 'var(--row-h)' }}
              >
                Duration
              </TableHead>
              <TableHead className="micro-label px-2.5" scope="col" style={{ height: 'var(--row-h)' }}>
                Message
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {checks.length === 0 ? (
              <TableRow>
                <TableCell className="px-2.5 py-4 text-center text-ink-3" colSpan={4}>
                  The report did not include individual checks.
                </TableCell>
              </TableRow>
            ) : (
              checks.map((check, index) => (
                <TableRow key={`${check.name}-${index}`}>
                  <TableCell className="num px-2.5 font-medium" style={{ height: 'var(--row-h)' }}>
                    {check.name}
                  </TableCell>
                  <TableCell className="px-2.5">
                    <HealthStatus status={check.status} />
                  </TableCell>
                  <TableCell className="px-2.5 text-right">
                    {check.durationMs === undefined ? (
                      <span className="num">—</span>
                    ) : (
                      <DurationBadge value={check.durationMs} />
                    )}
                  </TableCell>
                  <TableCell className="max-w-72 px-2.5 text-ink-3">
                    <span className="num line-clamp-3 break-words" title={check.message}>
                      {check.message ?? '—'}
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function HealthCheckDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const value = content(entry)
  return (
    <EntryDetailDrawer
      description={`${value.checks.length} checks · ${formatDateTime(entry.createdAt)}`}
      meta={<HealthStatus status={value.status} />}
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title="Health check report"
    >
      <CheckResultsTable checks={value.checks} />
      <JsonTree label="Raw health report" value={value} />
    </EntryDetailDrawer>
  )
}

export const healthChecksEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Health checks',
  description: 'Inspect readiness reports and identify unhealthy infrastructure dependencies.',
  caption: 'Recorded health check reports',
  columns,
  emptyTitle: () => 'Waiting for a readiness report',
  emptyDescription: () =>
    'Run the application HealthChecks instance while the health watcher is enabled. The aggregate status and each dependency check will appear here.',
  rowLabel: (entry) => {
    const value = content(entry)
    return `${value.status} health report with ${failingCount(value)} failing checks`
  },
  detailComponent: HealthCheckDetail,
}
