import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { DurationBadge } from '@/components/duration-badge'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
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

function statusBadge(status: HealthCheckResult['status']) {
  const variant =
    status === 'error'
      ? 'error'
      : status === 'warning'
        ? 'warning'
        : status === 'ok'
          ? 'success'
          : 'outline'
  return <Badge variant={variant}>{status}</Badge>
}

function failingCount(value: HealthCheckContent): number {
  return value.checks.filter((check) => check.status === 'error').length
}

const columns: EntryColumn[] = [
  {
    key: 'status',
    header: 'Status',
    primary: true,
    cell: (entry) => statusBadge(content(entry).status),
  },
  {
    key: 'failing',
    header: 'Failing checks',
    cell: (entry) => {
      const count = failingCount(content(entry))
      return <span className={count > 0 ? 'font-medium text-destructive-foreground' : undefined}>{count}</span>
    },
  },
  {
    key: 'checks',
    header: 'Checks',
    cell: (entry) => content(entry).checks.length.toLocaleString(),
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

function CheckResultsTable({ checks }: { checks: HealthCheckResult[] }) {
  return (
    <section aria-labelledby="health-check-results-heading" className="overflow-hidden rounded-md border">
      <div className="border-b bg-muted/35 px-3 py-2">
        <h3 className="text-xs font-medium" id="health-check-results-heading">
          Check results
        </h3>
      </div>
      <div className="overflow-x-auto">
        <Table className="min-w-[34rem] text-xs">
          <TableCaption className="sr-only">Individual health check results</TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-8 px-2.5">Check</TableHead>
              <TableHead className="h-8 w-24 px-2.5">Status</TableHead>
              <TableHead className="h-8 w-24 px-2.5 text-right">Duration</TableHead>
              <TableHead className="h-8 px-2.5">Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {checks.length === 0 ? (
              <TableRow>
                <TableCell className="px-2.5 py-4 text-center text-muted-foreground" colSpan={4}>
                  The report did not include individual checks.
                </TableCell>
              </TableRow>
            ) : (
              checks.map((check, index) => (
                <TableRow key={`${check.name}-${index}`}>
                  <TableCell className="px-2.5 py-2 font-medium">{check.name}</TableCell>
                  <TableCell className="px-2.5 py-2">{statusBadge(check.status)}</TableCell>
                  <TableCell className="px-2.5 py-2 text-right">
                    {check.durationMs === undefined ? '—' : <DurationBadge value={check.durationMs} />}
                  </TableCell>
                  <TableCell className="max-w-72 px-2.5 py-2 text-muted-foreground">
                    <span className="line-clamp-3 break-words">{check.message ?? '—'}</span>
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
      meta={statusBadge(value.status)}
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
  emptyTitle: () => 'Waiting for health checks',
  emptyDescription: () => 'Run your application HealthChecks instance to record a readiness report.',
  rowLabel: (entry) => {
    const value = content(entry)
    return `${value.status} health report with ${failingCount(value)} failing checks`
  },
  detailComponent: HealthCheckDetail,
}
