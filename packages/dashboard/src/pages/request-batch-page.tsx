import {
  ArrowLeft,
  Braces,
  CircleAlert,
  Clock3,
  Download,
  Globe2,
  Inbox,
  Network,
  UserRound,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import { DurationBadge } from '@/components/duration-badge'
import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import {
  MethodTag,
  Panel,
  PanelBody,
  PanelHeader,
  StatusDot,
  Well,
} from '@/components/instrument'
import { JsonTree } from '@/components/json-tree'
import { StatusBadge } from '@/components/status-badge'
import { EntryTagChips } from '@/components/tag-chip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { useDashboard } from '@/dashboard-context'
import { RegistryEntryDetail } from '@/entry-type-registry'
import type { RegisteredEntryDetailProps } from '@/entry-type-registry'
import { api } from '@/lib/api'
import {
  asString,
  formatBytes,
  formatDateTime,
  sequenceCompareAscending,
  truncate,
} from '@/lib/format'
import { detectNPlusOneWarnings } from '@/lib/n-plus-one'
import { BatchWaterfall } from '@/pages/batch-waterfall'
import type {
  CacheContent,
  CommandContent,
  DumpContent,
  GateContent,
  HttpClientContent,
  MailContent,
  ModelContent,
  RequestContent,
  StoredEntry,
  ViewContent,
} from '@/types'

function entrySummary(entry: StoredEntry): string {
  switch (entry.type) {
    case 'request': {
      const content = entry.content as RequestContent
      return `${asString(content.method, 'Request')} ${asString(content.url, '')}`.trim()
    }
    case 'query':
      return truncate(asString(entry.content.sql, 'Database query'), 120)
    case 'exception':
      return asString(entry.content.message, 'Exception')
    case 'command': {
      const content = entry.content as CommandContent
      return asString(content.command, 'Command')
    }
    case 'mail': {
      const content = entry.content as MailContent
      const subject = asString(content.subject, '').trim()
      if (subject) return subject
      const event = asString(content.event, 'mail').replace('_', ' ')
      return `${event} via ${asString(content.mailer, 'mailer')}`
    }
    case 'cache': {
      const content = entry.content as CacheContent
      const operation = asString(content.operation, 'cache')
      return `${operation} ${asString(content.key, content.store)}`.trim()
    }
    case 'model': {
      const content = entry.content as ModelContent
      return `${asString(content.action, 'model')} ${asString(content.model, 'Model')}`
    }
    case 'gate': {
      const content = entry.content as GateContent
      const decision = content.allowed === true ? 'Allowed' : 'Denied'
      return `${decision} ${asString(content.ability, 'ability')}`
    }
    case 'dump': {
      const content = entry.content as DumpContent
      return content.caller
        ? `Dump at ${content.caller.file}:${content.caller.line}`
        : 'Dumped value'
    }
    case 'http_client': {
      const content = entry.content as HttpClientContent
      return `${asString(content.method, 'HTTP')} ${asString(content.url, 'request')}`
    }
    case 'view':
      return asString((entry.content as ViewContent).template, 'Edge view')
    default:
      return asString(entry.content.message, `${entry.type.replace('_', ' ')} entry`)
  }
}

export function RequestEntryDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const request = entry.content as RequestContent

  return (
    <EntryDetailDrawer
      description={request.routePattern ?? 'Unmatched route'}
      meta={
        <>
          <MethodTag method={request.method} />
          <StatusBadge status={request.status} />
          <DurationBadge value={request.durationMs} />
          {request.clientDisconnected && (
            <span className="inline-flex items-center gap-1.5 text-xs text-sig-warn">
              <StatusDot signal="warn" />
              client disconnected
            </span>
          )}
        </>
      }
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(request.url, 120)}
    >
      <Panel>
        <PanelHeader title="Request" />
        <PanelBody className="space-y-3">
          <div className="min-w-0">
            <h3 className="num break-all text-sm font-semibold text-ink">{request.url}</h3>
            <p className="num mt-1 text-xs text-ink-3">
              {request.routePattern ?? 'Unmatched route'}
              {request.routeName ? ` · ${request.routeName}` : ''}
            </p>
          </div>
          {request.traceId && (
            <p className="num truncate text-xs text-ink-3" title={request.traceId}>
              Trace {request.traceId}
            </p>
          )}
          {request.inertia && (
            <Well className="flex flex-col gap-1.5 px-3 py-2 text-xs sm:flex-row sm:items-start sm:gap-3">
              <span className="flex shrink-0 items-center gap-1.5 font-medium text-ink">
                <Braces aria-hidden="true" className="size-3.5 text-ink-3" />
                Inertia
              </span>
              <span className="min-w-0">
                <span className="num block break-all font-medium text-ink">
                  {request.inertia.component}
                </span>
                {request.inertia.propKeys && (
                  <span className="num mt-0.5 block break-words text-ink-3">
                    Props: {request.inertia.propKeys.join(', ') || 'None'}
                  </span>
                )}
              </span>
            </Well>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Request metadata" />
        <PanelBody>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="min-w-0">
              <dt className="micro-label flex items-center gap-1.5">
                <Globe2 aria-hidden="true" className="size-3.5" /> Client
              </dt>
              <dd className="num mt-1 break-all text-sm text-ink">{request.ip}</dd>
            </div>
            <div className="min-w-0">
              <dt className="micro-label flex items-center gap-1.5">
                <UserRound aria-hidden="true" className="size-3.5" /> User
              </dt>
              <dd
                className="num mt-1 truncate text-sm text-ink"
                title={String(request.user?.email ?? request.user?.id ?? 'Guest')}
              >
                {request.user?.email ?? request.user?.id ?? 'Guest'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="micro-label flex items-center gap-1.5">
                <Clock3 aria-hidden="true" className="size-3.5" /> Memory delta
              </dt>
              <dd className="num mt-1 text-sm text-ink">{formatBytes(request.memoryDeltaBytes)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="micro-label">Batch ID</dt>
              <dd className="num mt-1 truncate text-xs text-ink" title={entry.batchId}>
                {entry.batchId}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="micro-label">Entry UUID</dt>
              <dd className="num mt-1 truncate text-xs text-ink" title={entry.uuid}>
                {entry.uuid}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="micro-label">Recorded</dt>
              <dd className="num mt-1 whitespace-nowrap text-xs text-ink">
                <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
              </dd>
            </div>
          </dl>
        </PanelBody>
      </Panel>

      <Tabs defaultValue="headers">
        <div className="overflow-x-auto border-b border-edge">
          <TabsList className="min-w-max" variant="underline">
            <TabsTab value="headers">Headers</TabsTab>
            <TabsTab value="payload">Payload</TabsTab>
            <TabsTab value="response">Response</TabsTab>
            <TabsTab value="session">Session</TabsTab>
          </TabsList>
        </div>
        <TabsPanel className="pt-3" value="headers">
          <JsonTree label="Request headers" value={request.headers} />
        </TabsPanel>
        <TabsPanel className="space-y-4 pt-3" value="payload">
          <JsonTree label="Query parameters" value={request.query} />
          <JsonTree label="Request payload" value={request.payload} />
        </TabsPanel>
        <TabsPanel className="space-y-3 pt-3" value="response">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-3">HTTP status</span>
            <StatusBadge status={request.status} />
          </div>
          <JsonTree label="Response body" value={request.response ?? null} />
        </TabsPanel>
        <TabsPanel className="pt-3" value="session">
          {request.session === undefined ? (
            <p className="well p-3 text-sm text-ink-3">
              No session snapshot was captured for this request.
            </p>
          ) : (
            <JsonTree label="Session snapshot" value={request.session} />
          )}
        </TabsPanel>
      </Tabs>

      <Button
        render={<Link to={`/requests/${encodeURIComponent(entry.batchId)}`} />}
        variant="outline"
      >
        <Network aria-hidden="true" />
        Open request batch
      </Button>
    </EntryDetailDrawer>
  )
}

export function RequestBatchPage() {
  const { batchId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const tag = searchParams.get('tag')
  const { status } = useDashboard()
  const [entries, setEntries] = useState<StoredEntry[]>([])
  const [selected, setSelected] = useState<StoredEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      setError(null)
      try {
        setEntries(await api.getBatch(batchId, signal))
      } catch (cause) {
        if (!signal?.aborted) {
          setError(cause instanceof Error ? cause : new Error('Unable to load batch'))
        }
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [batchId]
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const timeline = useMemo(
    () =>
      [...entries].sort((left, right) => sequenceCompareAscending(left.sequence, right.sequence)),
    [entries]
  )
  const nPlusOneWarnings = useMemo(
    () => detectNPlusOneWarnings(entries, status?.nPlusOneThreshold ?? 5),
    [entries, status?.nPlusOneThreshold]
  )
  const requestEntry = entries.find((entry) => entry.type === 'request')
  const request = requestEntry?.content as RequestContent | undefined
  const backTarget = `/requests${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`

  if (loading) {
    return (
      <div className="space-y-4" aria-label="Loading batch">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <Empty className="min-h-96">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleAlert aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Batch could not be loaded</EmptyTitle>
          <EmptyDescription>{error.message}</EmptyDescription>
        </EmptyHeader>
        <div className="flex gap-2">
          <Button render={<Link to={backTarget} />} variant="ghost">
            Back to requests
          </Button>
          <Button onClick={() => void load()} variant="outline">
            Try again
          </Button>
        </div>
      </Empty>
    )
  }

  if (entries.length === 0) {
    return (
      <Empty className="min-h-96">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Inbox aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Batch is empty</EmptyTitle>
          <EmptyDescription>
            Its recorded entries may have expired under the retention policy.
          </EmptyDescription>
        </EmptyHeader>
        <Button render={<Link to={backTarget} />} variant="outline">
          Back to requests
        </Button>
      </Empty>
    )
  }

  if (!requestEntry || !request) {
    const firstEntry = timeline[0]!
    const indexPath =
      firstEntry.type === 'exception'
        ? '/exceptions'
        : firstEntry.type === 'query'
          ? '/queries'
          : '/requests'
    const indexLabel =
      firstEntry.type === 'exception'
        ? 'exceptions'
        : firstEntry.type === 'query'
          ? 'queries'
          : 'requests'
    const genericBackTarget = `${indexPath}${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`
    const entryTypes = [...new Set(entries.map((entry) => entry.type.replace('_', ' ')))]

    return (
      <div className="space-y-4">
        <Button render={<Link to={genericBackTarget} />} size="sm" variant="ghost">
          <ArrowLeft aria-hidden="true" />
          Back to {indexLabel}
        </Button>

        <Panel aria-labelledby="ambient-batch-title">
          <PanelHeader
            className="max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-1 max-sm:py-2 max-sm:[&>h2]:basis-full max-sm:[&>h2]:shrink-0"
            action={
              <Button
                render={<a download href={api.getBatchExportUrl(batchId)} />}
                size="xs"
                variant="ghost"
              >
                <Download aria-hidden="true" />
                Export JSON
              </Button>
            }
            id="ambient-batch-title"
            meta={
              <time className="num" dateTime={firstEntry.createdAt}>
                {formatDateTime(firstEntry.createdAt)}
              </time>
            }
            title="Ambient process batch"
          />
          <PanelBody className="space-y-4">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                {entryTypes.map((type) => (
                  <span className="num text-micro text-ink-3" key={type}>
                    {type}
                  </span>
                ))}
              </div>
              <h2 className="num break-all text-md font-semibold text-ink">
                {entrySummary(firstEntry)}
              </h2>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-3">
                This batch was recorded outside an HTTP request lifecycle. Its entries remain
                available in sequence order.
              </p>
            </div>
            <Well>
              <dl className="grid divide-y divide-edge sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                <div className="min-w-0 p-3">
                  <dt className="micro-label">Batch ID</dt>
                  <dd className="num mt-1 truncate text-xs text-ink" title={firstEntry.batchId}>
                    {firstEntry.batchId}
                  </dd>
                </div>
                <div className="min-w-0 p-3">
                  <dt className="micro-label">Entries</dt>
                  <dd className="num mt-1 text-sm text-ink">{entries.length.toLocaleString()}</dd>
                </div>
                <div className="min-w-0 p-3">
                  <dt className="micro-label">Entry types</dt>
                  <dd className="num mt-1 break-words text-sm text-ink">
                    {entryTypes.join(', ')}
                  </dd>
                </div>
              </dl>
            </Well>
          </PanelBody>
        </Panel>

        <BatchWaterfall onSelect={setSelected} summary={entrySummary} timeline={timeline} />

        {selected && (
          <RegistryEntryDetail
            entry={selected}
            onClose={() => setSelected(null)}
            open={selected !== null}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Button render={<Link to={backTarget} />} size="sm" variant="ghost">
        <ArrowLeft aria-hidden="true" />
        All requests
      </Button>

      <Panel aria-labelledby="request-batch-title">
        <PanelHeader
          className="max-sm:h-auto max-sm:flex-wrap max-sm:gap-y-1 max-sm:py-2 max-sm:[&>h2]:basis-full max-sm:[&>h2]:shrink-0"
          action={
            <Button
              render={<a download href={api.getBatchExportUrl(batchId)} />}
              size="xs"
              variant="ghost"
            >
              <Download aria-hidden="true" />
              Export JSON
            </Button>
          }
          id="request-batch-title"
          meta={
            <time className="num" dateTime={requestEntry.createdAt}>
              {formatDateTime(requestEntry.createdAt)}
            </time>
          }
          title="Request batch"
        />
        <PanelBody className="space-y-4">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <MethodTag method={request.method} />
              <StatusBadge status={request.status} />
              <DurationBadge value={request.durationMs} />
              {request.clientDisconnected && (
                <span className="inline-flex items-center gap-1.5 text-xs text-sig-warn">
                  <StatusDot signal="warn" />
                  client disconnected
                </span>
              )}
            </div>
            <h2 className="num break-all text-md font-semibold leading-6 text-ink">{request.url}</h2>
            <p className="num mt-1 text-xs text-ink-3">
              {request.routePattern ?? 'Unmatched route'}
              {request.routeName ? ` · ${request.routeName}` : ''}
            </p>
            {request.traceId && (
              <p className="num mt-1 truncate text-xs text-ink-3" title={request.traceId}>
                Trace {request.traceId}
              </p>
            )}
            {request.inertia && (
              <Well className="mt-3 flex flex-col gap-1.5 px-3 py-2 text-xs sm:flex-row sm:items-start sm:gap-3">
                <span className="flex shrink-0 items-center gap-1.5 font-medium text-ink">
                  <Braces aria-hidden="true" className="size-3.5 text-ink-3" />
                  Inertia
                </span>
                <span className="min-w-0">
                  <span className="num block break-all font-medium text-ink">
                    {request.inertia.component}
                  </span>
                  {request.inertia.propKeys && (
                    <span className="num mt-0.5 block break-words text-ink-3">
                      Props: {request.inertia.propKeys.join(', ') || 'None'}
                    </span>
                  )}
                </span>
              </Well>
            )}
          </div>
          {requestEntry.tags.length > 0 && (
            <div className="border-t border-edge pt-3">
              <EntryTagChips tags={requestEntry.tags} />
            </div>
          )}
          <Well>
            <dl className="grid divide-y divide-edge sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
              <div className="min-w-0 p-3">
                <dt className="micro-label flex items-center gap-1.5">
                  <Globe2 aria-hidden="true" className="size-3.5" /> Client
                </dt>
                <dd className="num mt-1 break-all text-sm text-ink">{request.ip}</dd>
              </div>
              <div className="min-w-0 p-3">
                <dt className="micro-label flex items-center gap-1.5">
                  <UserRound aria-hidden="true" className="size-3.5" /> User
                </dt>
                <dd
                  className="num mt-1 truncate text-sm text-ink"
                  title={String(request.user?.email ?? request.user?.id ?? 'Guest')}
                >
                  {request.user?.email ?? request.user?.id ?? 'Guest'}
                </dd>
              </div>
              <div className="min-w-0 p-3">
                <dt className="micro-label flex items-center gap-1.5">
                  <Clock3 aria-hidden="true" className="size-3.5" /> Memory delta
                </dt>
                <dd className="num mt-1 text-sm text-ink">
                  {formatBytes(request.memoryDeltaBytes)}
                </dd>
              </div>
              <div className="min-w-0 p-3">
                <dt className="micro-label">Batch ID</dt>
                <dd className="num mt-1 truncate text-xs text-ink" title={requestEntry.batchId}>
                  {requestEntry.batchId}
                </dd>
              </div>
            </dl>
          </Well>
        </PanelBody>
      </Panel>

      {nPlusOneWarnings.length > 0 && (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Potential N+1 query pattern</AlertTitle>
          <AlertDescription>
            {nPlusOneWarnings.length === 1 ? (
              <>
                One query shape ran{' '}
                <span className="num">{nPlusOneWarnings[0].count.toLocaleString()}</span> times in
                this batch.
              </>
            ) : (
              <>
                <span className="num">{nPlusOneWarnings.length.toLocaleString()}</span> query shapes
                crossed the warning threshold; the most repeated ran{' '}
                <span className="num">{nPlusOneWarnings[0].count.toLocaleString()}</span> times.
              </>
            )}{' '}
            Inspect the query waterfall before treating this as a defect.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="timeline">
        <div className="overflow-x-auto border-b border-edge">
          <TabsList className="min-w-max" variant="underline">
            <TabsTab value="timeline">
              Waterfall <span className="num">({timeline.length})</span>
            </TabsTab>
            <TabsTab value="headers">Headers</TabsTab>
            <TabsTab value="payload">Payload</TabsTab>
            <TabsTab value="response">Response</TabsTab>
            <TabsTab value="session">Session</TabsTab>
          </TabsList>
        </div>

        <TabsPanel className="pt-3" value="timeline">
          <BatchWaterfall onSelect={setSelected} summary={entrySummary} timeline={timeline} />
        </TabsPanel>

        <TabsPanel className="pt-3" value="headers">
          <JsonTree label="Request headers" value={request.headers} />
        </TabsPanel>
        <TabsPanel className="space-y-4 pt-3" value="payload">
          <JsonTree label="Query parameters" value={request.query} />
          <JsonTree label="Request payload" value={request.payload} />
        </TabsPanel>
        <TabsPanel className="space-y-4 pt-3" value="response">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ink-3">HTTP status</span>
            <StatusBadge status={request.status} />
          </div>
          <JsonTree label="Response body" value={request.response ?? null} />
        </TabsPanel>
        <TabsPanel className="pt-3" value="session">
          {request.session === undefined ? (
            <Empty className="min-h-64 rounded-lg border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UserRound aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No session snapshot</EmptyTitle>
                <EmptyDescription>
                  This request did not expose session data, or session capture is disabled.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <JsonTree label="Session snapshot" value={request.session} />
          )}
        </TabsPanel>
      </Tabs>

      {selected && (
        <RegistryEntryDetail
          entry={selected}
          onClose={() => setSelected(null)}
          open={selected !== null}
        />
      )}
    </div>
  )
}
