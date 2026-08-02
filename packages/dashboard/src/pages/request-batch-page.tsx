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
import { EntryTagChips } from '@/components/tag-chip'
import { JsonTree } from '@/components/json-tree'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Frame, FramePanel } from '@/components/ui/frame'
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
      description={`${request.routePattern ?? 'Unmatched route'} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <>
          <Badge className="font-mono" variant="outline">
            {request.method}
          </Badge>
          <StatusBadge status={request.status} />
          <DurationBadge value={request.durationMs} />
          {request.clientDisconnected && <Badge variant="warning">client disconnected</Badge>}
        </>
      }
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(request.url, 120)}
    >
      <section className="space-y-3 rounded-md border bg-muted/25 p-3">
        <div>
          <h3 className="font-mono text-sm font-semibold break-all">{request.url}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {request.routePattern ?? 'Unmatched route'}
            {request.routeName ? ` · ${request.routeName}` : ''}
          </p>
        </div>
        {request.traceId && (
          <p className="truncate font-mono text-xs text-muted-foreground">
            Trace <span title={request.traceId}>{request.traceId}</span>
          </p>
        )}
        {request.inertia && (
          <div className="flex flex-col gap-1.5 rounded-md border bg-background px-3 py-2 text-xs sm:flex-row sm:items-start sm:gap-3">
            <span className="flex shrink-0 items-center gap-1.5 font-medium text-foreground">
              <Braces aria-hidden="true" className="size-3.5 text-muted-foreground" />
              Inertia
            </span>
            <span className="min-w-0">
              <span className="block break-all font-mono font-medium text-foreground">
                {request.inertia.component}
              </span>
              {request.inertia.propKeys && (
                <span className="mt-0.5 block break-words text-muted-foreground">
                  Props: {request.inertia.propKeys.join(', ') || 'None'}
                </span>
              )}
            </span>
          </div>
        )}
      </section>

      <dl className="grid gap-2.5 rounded-md border p-3 sm:grid-cols-2">
        <div>
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Globe2 aria-hidden="true" className="size-3.5" /> Client
          </dt>
          <dd className="mt-1 break-all text-sm font-medium">{request.ip}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <UserRound aria-hidden="true" className="size-3.5" /> User
          </dt>
          <dd className="mt-1 truncate text-sm font-medium">
            {request.user?.email ?? request.user?.id ?? 'Guest'}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock3 aria-hidden="true" className="size-3.5" /> Memory delta
          </dt>
          <dd className="mt-1 font-mono text-sm font-medium">
            {formatBytes(request.memoryDeltaBytes)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Batch ID</dt>
          <dd className="mt-1 truncate font-mono text-xs font-medium" title={entry.batchId}>
            {entry.batchId}
          </dd>
        </div>
      </dl>

      <Tabs defaultValue="headers">
        <div className="overflow-x-auto border-b">
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
            <span className="text-muted-foreground">HTTP status</span>
            <StatusBadge status={request.status} />
          </div>
          <JsonTree label="Response body" value={request.response ?? null} />
        </TabsPanel>
        <TabsPanel className="pt-3" value="session">
          {request.session === undefined ? (
            <p className="rounded-md border bg-muted/25 p-3 text-sm text-muted-foreground">
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

        <Frame className="rounded-lg p-0.5">
          <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
            <section>
              <div className="flex flex-col gap-4 border-b p-3 sm:flex-row sm:items-start sm:justify-between sm:p-4">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">ambient/process batch</Badge>
                    {entryTypes.map((type) => (
                      <Badge className="font-mono" key={type} variant="outline">
                        {type}
                      </Badge>
                    ))}
                  </div>
                  <h2 className="break-all font-mono text-sm font-semibold leading-6 sm:text-base">
                    {entrySummary(firstEntry)}
                  </h2>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
                    This batch was recorded outside an HTTP request lifecycle. Its entries remain
                    available in sequence order.
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
                  <Button
                    render={<a download href={api.getBatchExportUrl(batchId)} />}
                    size="sm"
                    variant="outline"
                  >
                    <Download aria-hidden="true" />
                    Export JSON
                  </Button>
                  <div className="text-left sm:text-right">
                    <div className="text-xs text-muted-foreground">Recorded</div>
                    <time className="text-sm font-medium" dateTime={firstEntry.createdAt}>
                      {formatDateTime(firstEntry.createdAt)}
                    </time>
                  </div>
                </div>
              </div>
              <dl className="grid divide-y bg-muted/25 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                <div className="p-3">
                  <dt className="text-xs text-muted-foreground">Batch ID</dt>
                  <dd
                    className="mt-1 truncate font-mono text-xs font-medium"
                    title={firstEntry.batchId}
                  >
                    {firstEntry.batchId}
                  </dd>
                </div>
                <div className="p-3">
                  <dt className="text-xs text-muted-foreground">Entries</dt>
                  <dd className="mt-1 font-mono text-sm font-medium">
                    {entries.length.toLocaleString()}
                  </dd>
                </div>
                <div className="p-3">
                  <dt className="text-xs text-muted-foreground">Entry types</dt>
                  <dd className="mt-1 text-sm font-medium">{entryTypes.join(', ')}</dd>
                </div>
              </dl>
            </section>
          </FramePanel>
        </Frame>

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

      <Frame className="rounded-lg p-0.5">
        <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
          <section>
            <div className="flex flex-col gap-4 border-b p-3 sm:flex-row sm:items-start sm:justify-between sm:p-4">
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge className="font-mono" variant="outline">
                    {request.method}
                  </Badge>
                  <StatusBadge status={request.status} />
                  <DurationBadge value={request.durationMs} />
                  {request.clientDisconnected && (
                    <Badge variant="warning">client disconnected</Badge>
                  )}
                </div>
                <h2 className="break-all font-mono text-sm font-semibold leading-6 sm:text-base">
                  {request.url}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {request.routePattern ?? 'Unmatched route'}
                  {request.routeName ? ` · ${request.routeName}` : ''}
                </p>
                {request.traceId && (
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    Trace <span title={request.traceId}>{request.traceId}</span>
                  </p>
                )}
                {request.inertia && (
                  <div className="mt-3 flex flex-col gap-1.5 rounded-md border bg-muted/30 px-3 py-2 text-xs sm:flex-row sm:items-start sm:gap-3">
                    <span className="flex shrink-0 items-center gap-1.5 font-medium text-foreground">
                      <Braces aria-hidden="true" className="size-3.5 text-muted-foreground" />
                      Inertia
                    </span>
                    <span className="min-w-0">
                      <span className="block break-all font-mono font-medium text-foreground">
                        {request.inertia.component}
                      </span>
                      {request.inertia.propKeys && (
                        <span className="mt-0.5 block break-words text-muted-foreground">
                          Props: {request.inertia.propKeys.join(', ') || 'None'}
                        </span>
                      )}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
                <Button
                  render={<a download href={api.getBatchExportUrl(batchId)} />}
                  size="sm"
                  variant="outline"
                >
                  <Download aria-hidden="true" />
                  Export JSON
                </Button>
                <div className="text-left sm:text-right">
                  <div className="text-xs text-muted-foreground">Recorded</div>
                  <time className="text-sm font-medium" dateTime={requestEntry.createdAt}>
                    {formatDateTime(requestEntry.createdAt)}
                  </time>
                </div>
              </div>
            </div>
            {requestEntry.tags.length > 0 && (
              <div className="border-b px-3 py-2 sm:px-4">
                <EntryTagChips tags={requestEntry.tags} />
              </div>
            )}
            <dl className="grid divide-y bg-muted/25 sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
              <div className="p-3">
                <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Globe2 aria-hidden="true" className="size-3.5" /> Client
                </dt>
                <dd className="mt-1 break-all text-sm font-medium">{request.ip}</dd>
              </div>
              <div className="p-3">
                <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <UserRound aria-hidden="true" className="size-3.5" /> User
                </dt>
                <dd className="mt-1 truncate text-sm font-medium">
                  {request.user?.email ?? request.user?.id ?? 'Guest'}
                </dd>
              </div>
              <div className="p-3">
                <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock3 aria-hidden="true" className="size-3.5" /> Memory delta
                </dt>
                <dd className="mt-1 font-mono text-sm font-medium">
                  {formatBytes(request.memoryDeltaBytes)}
                </dd>
              </div>
              <div className="p-3">
                <dt className="text-xs text-muted-foreground">Batch ID</dt>
                <dd
                  className="mt-1 truncate font-mono text-xs font-medium"
                  title={requestEntry.batchId}
                >
                  {requestEntry.batchId}
                </dd>
              </div>
            </dl>
          </section>
        </FramePanel>
      </Frame>

      {nPlusOneWarnings.length > 0 && (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Potential N+1 query pattern</AlertTitle>
          <AlertDescription>
            {nPlusOneWarnings.length === 1
              ? `One query shape ran ${nPlusOneWarnings[0].count.toLocaleString()} times in this batch.`
              : `${nPlusOneWarnings.length.toLocaleString()} query shapes crossed the warning threshold; the most repeated ran ${nPlusOneWarnings[0].count.toLocaleString()} times.`}{' '}
            Inspect the query waterfall before treating this as a defect.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="timeline">
        <div className="overflow-x-auto border-b">
          <TabsList className="min-w-max" variant="underline">
            <TabsTab value="timeline">Waterfall ({timeline.length})</TabsTab>
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
            <span className="text-muted-foreground">HTTP status</span>
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
