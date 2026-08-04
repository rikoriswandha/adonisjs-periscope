import { ArrowUpRight } from 'lucide-react'

import { DurationBadge } from '@/components/duration-badge'
import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { HttpClientDurationChart } from '@/components/http-client-duration-chart'
import { JsonTree } from '@/components/json-tree'
import { StatusBadge } from '@/components/status-badge'
import { MethodTag, StatusDot } from '@/components/instrument'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { HttpClientContent, StoredEntry } from '@/types'

function httpClientContent(entry: StoredEntry): HttpClientContent {
  return entry.content as HttpClientContent
}

function HttpClientResult({ content }: { content: HttpClientContent }) {
  if (content.error !== undefined && content.error !== null) {
    return (
      <span className="num inline-flex flex-wrap items-center gap-2 text-xs">
        <StatusDot signal="error" />
        failed
        {content.status !== undefined && <StatusBadge status={content.status} />}
      </span>
    )
  }
  if (!content.completed) {
    return (
      <span className="num inline-flex items-center gap-2 text-xs">
        <StatusDot pulse signal="info" />
        pending
      </span>
    )
  }
  if (content.status !== undefined) return <StatusBadge status={content.status} />
  return (
    <span className="num inline-flex items-center gap-2 text-xs">
      <StatusDot signal="ok" />
      completed
    </span>
  )
}

const columns: EntryColumn[] = [
  {
    key: 'method',
    header: 'Method',
    className: 'w-24',
    cell: (entry) => <MethodTag method={httpClientContent(entry).method} />,
  },
  {
    key: 'url',
    header: 'Request',
    primary: true,
    cell: (entry) => {
      const content = httpClientContent(entry)
      return (
        <div className="min-w-0">
          <div className="num max-w-2xl truncate text-xs font-medium" title={content.url}>
            {truncate(content.url, 140)}
          </div>
          <div className="num mt-1 text-xs text-ink-3">
            {content.error !== undefined && content.error !== null
              ? 'Request failed'
              : content.completed
                ? 'Response received'
                : 'Waiting for response'}
          </div>
        </div>
      )
    },
  },
  {
    key: 'result',
    header: 'Result',
    className: 'w-36',
    cell: (entry) => <HttpClientResult content={httpClientContent(entry)} />,
  },
  {
    key: 'duration',
    header: 'Duration',
    className: 'w-28 text-right',
    cell: (entry) => <DurationBadge value={httpClientContent(entry).durationMs} />,
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36 text-right',
    cell: (entry) => (
      <span className="num block whitespace-nowrap text-right text-xs text-ink-3" title={entry.createdAt}>
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
  {
    key: 'open',
    header: '',
    className: 'w-10 text-right',
    cell: () => (
      <ArrowUpRight aria-hidden="true" className="ms-auto size-4 text-ink-3" />
    ),
  },
]

function HttpClientDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = httpClientContent(entry)
  return (
    <EntryDetailDrawer
      description={`Outbound request · ${formatDateTime(entry.createdAt)}`}
      meta={
        <>
          <HttpClientResult content={content} />
          <DurationBadge value={content.durationMs} />
        </>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(`${content.method} ${content.url}`, 96)}
    >
      <dl className="well grid gap-2.5 p-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-ink-3">Method</dt>
          <dd className="num mt-0.5 text-sm">{content.method}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Completion</dt>
          <dd className="mt-0.5">
            <span className="num inline-flex items-center gap-2 text-xs">
              <StatusDot
                signal={
                  content.error !== undefined && content.error !== null
                    ? 'error'
                    : content.completed
                      ? 'ok'
                      : 'info'
                }
              />
              {content.error !== undefined && content.error !== null
                ? 'Failed'
                : content.completed
                  ? 'Completed'
                  : 'In progress'}
            </span>
          </dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-ink-3">URL</dt>
          <dd className="num mt-0.5 break-all text-xs leading-5" title={content.url}>
            {content.url}
          </dd>
        </div>
      </dl>
      <section aria-labelledby="http-client-headers-title" className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold" id="http-client-headers-title">
            Headers
          </h3>
          <p className="mt-1 text-xs leading-5 text-ink-3">
            Sensitive header values are redacted during recording.
          </p>
        </div>
        <Tabs defaultValue="request">
          <div className="overflow-x-auto border-b">
            <TabsList className="min-w-max" variant="underline">
              <TabsTab value="request">Request</TabsTab>
              <TabsTab value="response">Response</TabsTab>
            </TabsList>
          </div>
          <TabsPanel className="pt-3" value="request">
            <JsonTree label="Redacted request headers" value={content.requestHeaders ?? null} />
          </TabsPanel>
          <TabsPanel className="pt-3" value="response">
            <JsonTree label="Redacted response headers" value={content.responseHeaders ?? null} />
          </TabsPanel>
        </Tabs>
      </section>
      {content.error !== undefined && content.error !== null && (
        <JsonTree label="HTTP client error" value={content.error} />
      )}
    </EntryDetailDrawer>
  )
}

export const httpClientEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'HTTP client requests',
  description:
    'Inspect outbound request timing, response status, redacted headers, and transport failures.',
  caption: 'Recorded outbound HTTP client requests',
  columns,
  emptyTitle: (tag?: string) =>
    tag ? 'No matching HTTP client requests' : 'Waiting for outbound requests',
  emptyDescription: (tag?: string) =>
    tag
      ? `No HTTP client request carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Make an outbound HTTP request while the HTTP client watcher is enabled. It will appear here automatically.',
  rowLabel: (entry: StoredEntry) => {
    const content = httpClientContent(entry)
    return `Inspect outbound request: ${content.method} ${truncate(content.url, 80)}`
  },
  detailComponent: HttpClientDetail,
  overviewComponent: HttpClientDurationChart,
}
