import { ArrowUpRight, Route } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { DurationBadge } from '@/components/duration-badge'
import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import { EntryIndexTable, type EntryColumn } from '@/components/entry-index-table'
import { HttpClientDurationChart } from '@/components/http-client-duration-chart'
import { JsonTree } from '@/components/json-tree'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { useDashboard } from '@/dashboard-context'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { EntryFilters, HttpClientContent, StoredEntry } from '@/types'

function httpClientContent(entry: StoredEntry): HttpClientContent {
  return entry.content as HttpClientContent
}

function HttpClientResult({ content }: { content: HttpClientContent }) {
  if (content.error !== undefined && content.error !== null) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant="destructive">failed</Badge>
        {content.status !== undefined && <StatusBadge status={content.status} />}
      </span>
    )
  }
  if (!content.completed) return <Badge variant="outline">pending</Badge>
  if (content.status !== undefined) return <StatusBadge status={content.status} />
  return <Badge variant="success">completed</Badge>
}

const columns: EntryColumn[] = [
  {
    key: 'method',
    header: 'Method',
    className: 'w-24',
    cell: (entry) => (
      <Badge className="font-mono" variant="outline">
        {httpClientContent(entry).method}
      </Badge>
    ),
  },
  {
    key: 'url',
    header: 'Request',
    primary: true,
    cell: (entry) => {
      const content = httpClientContent(entry)
      return (
        <div className="min-w-0">
          <div className="max-w-2xl truncate font-mono text-xs font-medium" title={content.url}>
            {truncate(content.url, 140)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
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
    className: 'w-32',
    cell: (entry) => <HttpClientResult content={httpClientContent(entry)} />,
  },
  {
    key: 'duration',
    header: 'Duration',
    className: 'w-28',
    cell: (entry) => <DurationBadge value={httpClientContent(entry).durationMs} />,
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36',
    cell: (entry) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground" title={entry.createdAt}>
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
  {
    key: 'open',
    header: '',
    className: 'w-10 text-right',
    cell: () => (
      <ArrowUpRight aria-hidden="true" className="ms-auto size-4 text-muted-foreground" />
    ),
  },
]

export function HttpClientPage() {
  const [searchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const [selected, setSelected] = useState<StoredEntry | null>(null)
  const tag = searchParams.get('tag')?.trim() || undefined
  const filters = useMemo<EntryFilters>(
    () => ({ type: 'http_client', tag, displayOnIndex: true, limit: 50 }),
    [tag]
  )
  const pagination = useCursorPagination(filters)
  const reload = pagination.reload
  const polling = useNewEntryPolling(pagination.entries, filters, status?.paused ?? true, revision)

  useEffect(() => {
    if (revision > 0) void reload()
  }, [reload, revision])

  const content = selected ? httpClientContent(selected) : null
  const acceptNew = () => pagination.prepend(polling.accept())

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold tracking-tight">HTTP client requests</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Inspect outbound request timing, response status, redacted headers, and transport
            failures.
          </p>
        </div>
        {tag && (
          <Badge variant="info">
            <Route aria-hidden="true" />
            tag:{tag}
          </Badge>
        )}
      </section>

      <HttpClientDurationChart entries={pagination.entries} />

      <EntryIndexTable
        caption="Recorded outbound HTTP client requests"
        columns={columns}
        emptyDescription={
          tag
            ? `No HTTP client request carries the exact tag “${tag}”. Try another tag or clear the filter.`
            : 'Make an outbound HTTP request while the HTTP client watcher is enabled. It will appear here automatically.'
        }
        emptyTitle={tag ? 'No matching HTTP client requests' : 'Waiting for outbound requests'}
        error={pagination.error}
        hasMore={pagination.hasMore}
        loading={pagination.loading}
        loadingMore={pagination.loadingMore}
        newCount={polling.pending.length}
        onAcceptNew={acceptNew}
        onLoadMore={() => void pagination.loadMore()}
        onRetry={() => void pagination.reload()}
        onRowOpen={setSelected}
        rowLabel={(entry) => {
          const entryContent = httpClientContent(entry)
          return `Inspect outbound request: ${entryContent.method} ${truncate(entryContent.url, 80)}`
        }}
        rows={pagination.entries}
      />

      <EntryDetailDrawer
        description={
          selected
            ? `Outbound request · ${formatDateTime(selected.createdAt)}`
            : 'HTTP client request detail'
        }
        meta={
          content && (
            <>
              <HttpClientResult content={content} />
              <DurationBadge value={content.durationMs} />
            </>
          )
        }
        onOpenChange={(open) => !open && setSelected(null)}
        open={selected !== null}
        title={
          content ? truncate(`${content.method} ${content.url}`, 96) : 'HTTP client request detail'
        }
      >
        {content && (
          <>
            <dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Method</dt>
                <dd className="mt-1 font-mono text-sm">{content.method}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Completion</dt>
                <dd className="mt-1 text-sm">{content.completed ? 'Completed' : 'In progress'}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">URL</dt>
                <dd className="mt-1 break-all font-mono text-xs leading-5">{content.url}</dd>
              </div>
            </dl>

            <section aria-labelledby="http-client-headers-title" className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold" id="http-client-headers-title">
                  Headers
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
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
                  <JsonTree
                    label="Redacted request headers"
                    value={content.requestHeaders ?? null}
                  />
                </TabsPanel>
                <TabsPanel className="pt-3" value="response">
                  <JsonTree
                    label="Redacted response headers"
                    value={content.responseHeaders ?? null}
                  />
                </TabsPanel>
              </Tabs>
            </section>

            {content.error !== undefined && content.error !== null && (
              <JsonTree label="HTTP client error" value={content.error} />
            )}
          </>
        )}
      </EntryDetailDrawer>
    </div>
  )
}
