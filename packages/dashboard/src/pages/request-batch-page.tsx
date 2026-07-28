import {
  ArrowLeft,
  Box,
  Braces,
  Bug,
  CircleAlert,
  Clock3,
  Database,
  DatabaseZap,
  FileJson,
  Download,
  Globe2,
  Inbox,
  Mail,
  Network,
  ShieldCheck,
  SquareTerminal,
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
import { api } from '@/lib/api'
import {
  asNumber,
  asString,
  formatBytes,
  formatDateTime,
  sequenceCompareAscending,
  truncate,
} from '@/lib/format'
import { detectNPlusOneWarnings } from '@/lib/n-plus-one'
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
    default:
      return asString(entry.content.message, `${entry.type.replace('_', ' ')} entry`)
  }
}

function TimelineIcon({ type }: { type: StoredEntry['type'] }) {
  switch (type) {
    case 'query':
      return <Database aria-hidden="true" />
    case 'exception':
      return <Bug aria-hidden="true" />
    case 'request':
      return <Network aria-hidden="true" />
    case 'command':
      return <SquareTerminal aria-hidden="true" />
    case 'mail':
      return <Mail aria-hidden="true" />
    case 'cache':
      return <DatabaseZap aria-hidden="true" />
    case 'model':
      return <Box aria-hidden="true" />
    case 'gate':
      return <ShieldCheck aria-hidden="true" />
    case 'dump':
      return <Braces aria-hidden="true" />
    case 'http_client':
      return <Globe2 aria-hidden="true" />
    default:
      return <FileJson aria-hidden="true" />
  }
}

function BatchTimeline({
  timeline,
  onSelect,
}: {
  timeline: StoredEntry[]
  onSelect: (entry: StoredEntry) => void
}) {
  return (
    <Frame className="rounded-lg p-0.5">
      <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
        <section aria-label="Batch timeline">
          <ol className="divide-y">
            {timeline.map((entry, index) => {
              const duration = asNumber(entry.content.durationMs)
              return (
                <li key={entry.uuid}>
                  <button
                    className="grid w-full grid-cols-[1.75rem_minmax(0,1fr)] gap-3 px-3 py-2 text-left outline-none transition-colors hover:bg-accent/45 focus-visible:bg-accent/55 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[1.75rem_7rem_minmax(0,1fr)_auto] sm:items-center"
                    onClick={() => onSelect(entry)}
                    type="button"
                  >
                    <span className="grid size-7 place-items-center rounded-md border bg-muted text-muted-foreground [&_svg]:size-4">
                      <TimelineIcon type={entry.type} />
                    </span>
                    <span className="hidden font-mono text-xs text-muted-foreground sm:block">
                      +{index.toString().padStart(2, '0')} · {entry.type.replace('_', ' ')}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {entrySummary(entry)}
                      </span>
                      <span className="mt-0.5 block font-mono text-2xs text-muted-foreground sm:hidden">
                        {entry.type.replace('_', ' ')}
                      </span>
                    </span>
                    <span className="col-start-2 flex items-center gap-2 sm:col-auto">
                      {duration !== undefined && <DurationBadge value={duration} />}
                      {entry.type === 'exception' && (
                        <Badge variant="destructive">exception</Badge>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </section>
      </FramePanel>
    </Frame>
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
                <div className="shrink-0 text-left sm:text-right">
                  <div className="text-xs text-muted-foreground">Recorded</div>
                  <time className="text-sm font-medium" dateTime={firstEntry.createdAt}>
                    {formatDateTime(firstEntry.createdAt)}
                  </time>
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

        <BatchTimeline onSelect={setSelected} timeline={timeline} />

        <EntryDetailDrawer
          description={selected ? formatDateTime(selected.createdAt) : 'Timeline entry'}
          meta={
            selected && (
              <>
                <Badge variant="secondary">{selected.type.replace('_', ' ')}</Badge>
                {asNumber(selected.content.durationMs) !== undefined && (
                  <DurationBadge value={asNumber(selected.content.durationMs)} />
                )}
              </>
            )
          }
          onOpenChange={(open) => !open && setSelected(null)}
          open={selected !== null}
          tags={selected?.tags}
          title={selected ? entrySummary(selected) : 'Timeline entry'}
        >
          {selected && <JsonTree label="Entry content" value={selected.content} />}
        </EntryDetailDrawer>
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
            Inspect the query timeline before treating this as a defect.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="timeline">
        <div className="overflow-x-auto border-b">
          <TabsList className="min-w-max" variant="underline">
            <TabsTab value="timeline">Timeline ({timeline.length})</TabsTab>
            <TabsTab value="headers">Headers</TabsTab>
            <TabsTab value="payload">Payload</TabsTab>
            <TabsTab value="response">Response</TabsTab>
            <TabsTab value="session">Session</TabsTab>
          </TabsList>
        </div>

        <TabsPanel className="pt-3" value="timeline">
          <BatchTimeline onSelect={setSelected} timeline={timeline} />
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

      <EntryDetailDrawer
        description={selected ? formatDateTime(selected.createdAt) : 'Timeline entry'}
        meta={
          selected && (
            <>
              <Badge variant="secondary">{selected.type.replace('_', ' ')}</Badge>
              {asNumber(selected.content.durationMs) !== undefined && (
                <DurationBadge value={asNumber(selected.content.durationMs)} />
              )}
            </>
          )
        }
        onOpenChange={(open) => !open && setSelected(null)}
        open={selected !== null}
        tags={selected?.tags}
        title={selected ? entrySummary(selected) : 'Timeline entry'}
      >
        {selected && <JsonTree label="Entry content" value={selected.content} />}
      </EntryDetailDrawer>
    </div>
  )
}
