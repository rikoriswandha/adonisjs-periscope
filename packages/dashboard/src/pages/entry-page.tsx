import { ArrowLeft, CircleAlert, Files, Pin } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { PageHeader } from '@/components/page-header'
import { Panel, PanelBody, PanelHeader } from '@/components/instrument'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { RegistryEntryDetail } from '@/entry-type-registry'
import { api, ApiError } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import type { EntryMetadataRecord, StoredEntry } from '@/types'
import { entryTypeLabel } from '@/wave2-entry-types'

type EntryLoadState =
  | { status: 'loading' }
  | { status: 'ready'; entry: StoredEntry }
  | { status: 'not-found' }
  | { status: 'error'; error: Error }

export function EntryPage() {
  const { uuid = '' } = useParams()
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<EntryLoadState>({ status: 'loading' })
  const [metadata, setMetadata] = useState<EntryMetadataRecord>({
    note: null,
    pinned: false,
    updatedAt: null,
    uuid,
  })
  const [noteDraft, setNoteDraft] = useState('')
  const [metadataLoading, setMetadataLoading] = useState(true)
  const [metadataSaving, setMetadataSaving] = useState(false)
  const [metadataError, setMetadataError] = useState<Error | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setMetadataLoading(true)
    setMetadataError(null)
    api
      .fetchEntryMetadata(controller.signal)
      .then((records) => {
        const record = records.find((candidate) => candidate.uuid === uuid) ?? {
          note: null,
          pinned: false,
          updatedAt: null,
          uuid,
        }
        setMetadata(record)
        setNoteDraft(record.note ?? '')
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setMetadataError(
          cause instanceof Error ? cause : new Error('Entry metadata could not be loaded')
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setMetadataLoading(false)
      })
    return () => controller.abort()
  }, [uuid])

  const updateMetadata = async (patch: { pinned?: boolean; note?: string | null }) => {
    setMetadataSaving(true)
    setMetadataError(null)
    try {
      const record = await api.putEntryMetadata(uuid, patch)
      setMetadata(record)
      setNoteDraft(record.note ?? '')
    } catch (cause) {
      setMetadataError(
        cause instanceof Error ? cause : new Error('Entry metadata could not be saved')
      )
    } finally {
      setMetadataSaving(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    api
      .getEntry(uuid, controller.signal)
      .then((entry) => setState({ entry, status: 'ready' }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        if (cause instanceof ApiError && cause.status === 404) {
          setState({ status: 'not-found' })
          return
        }
        setState({
          error: cause instanceof Error ? cause : new Error('Unable to load this entry'),
          status: 'error',
        })
      })
    return () => controller.abort()
  }, [retry, uuid])

  if (state.status === 'loading') {
    return (
      <div aria-label="Loading entry" className="space-y-4" role="status">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (state.status === 'not-found') {
    return (
      <Empty className="min-h-96">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Files aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Entry not found</EmptyTitle>
          <EmptyDescription>
            No recorded entry has UUID <span className="num">{uuid}</span>. It may have expired
            under the retention policy.
          </EmptyDescription>
        </EmptyHeader>
        <Button render={<Link to="/requests" />} variant="outline">
          <ArrowLeft aria-hidden="true" />
          Back to requests
        </Button>
      </Empty>
    )
  }

  if (state.status === 'error') {
    return (
      <Empty className="min-h-96">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleAlert aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Entry could not be loaded</EmptyTitle>
          <EmptyDescription>{state.error.message}</EmptyDescription>
        </EmptyHeader>
        <div className="flex flex-wrap gap-2">
          <Button render={<Link to="/requests" />} variant="ghost">
            Back to requests
          </Button>
          <Button onClick={() => setRetry((value) => value + 1)} variant="outline">
            Try again
          </Button>
        </div>
      </Empty>
    )
  }

  const { entry } = state
  return (
    <div className="space-y-4">
      <Button render={<Link to="/requests" />} size="sm" variant="ghost">
        <ArrowLeft aria-hidden="true" />
        Back to requests
      </Button>

      <PageHeader
        aside={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-h-[var(--control-h)] items-center gap-2 rounded-sm border border-edge bg-panel px-2 text-xs font-medium text-ink [@media(pointer:coarse)]:min-h-11">
              <Pin
                aria-hidden="true"
                className={`size-3.5 ${metadata.pinned ? 'fill-current text-ink' : 'text-ink-3'}`}
              />
              Pinned
              <Switch
                aria-label="Pin this entry"
                checked={metadata.pinned}
                disabled={metadataLoading || metadataSaving}
                onCheckedChange={(pinned) => void updateMetadata({ pinned })}
              />
            </label>
            <span className="num text-xs text-ink-2">{entryTypeLabel(entry.type)}</span>
            <Button
              render={<Link to={`/requests/${encodeURIComponent(entry.batchId)}`} />}
              size="xs"
              variant="outline"
            >
              <Files aria-hidden="true" />
              Open batch
            </Button>
          </div>
        }
        description="Inspect this recorded entry and its captured context."
        title={`${entryTypeLabel(entry.type)} entry`}
      />

      <Panel aria-labelledby="entry-metadata-title">
        <PanelHeader id="entry-metadata-title" title="Entry metadata" />
        <PanelBody>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="min-w-0">
              <dt className="micro-label">Entry UUID</dt>
              <dd className="num mt-1 truncate text-xs text-ink" title={entry.uuid}>
                {entry.uuid}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="micro-label">Batch ID</dt>
              <dd className="num mt-1 truncate text-xs text-ink" title={entry.batchId}>
                {entry.batchId}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="micro-label">Recorded</dt>
              <dd className="num mt-1 whitespace-nowrap text-xs text-ink">
                <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="micro-label">Sequence</dt>
              <dd className="num mt-1 truncate text-xs text-ink" title={entry.sequence}>
                {entry.sequence}
              </dd>
            </div>
          </dl>
        </PanelBody>
      </Panel>

      <Panel aria-busy={metadataLoading || metadataSaving} aria-labelledby="entry-note-title">
        <PanelHeader id="entry-note-title" meta="2,000 character limit" title="Note" />
        <PanelBody className="space-y-3">
          <p className="text-xs text-ink-3">Add private context for this recorded entry.</p>
          <Textarea
            aria-label="Entry note"
            disabled={metadataLoading || metadataSaving}
            maxLength={2000}
            onChange={(event) => setNoteDraft(event.currentTarget.value)}
            placeholder="Add a note…"
            rows={4}
            value={noteDraft}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="num text-micro text-ink-3">
              {noteDraft.length.toLocaleString()} / 2,000
              {metadata.updatedAt ? ` · Updated ${formatDateTime(metadata.updatedAt)}` : ''}
            </span>
            <Button
              disabled={noteDraft === (metadata.note ?? '')}
              loading={metadataSaving}
              onClick={() => void updateMetadata({ note: noteDraft === '' ? null : noteDraft })}
              size="sm"
              variant="outline"
            >
              Save note
            </Button>
          </div>
          {metadataError && (
            <p className="text-xs text-sig-error" role="alert">
              {metadataError.message}
            </p>
          )}
        </PanelBody>
      </Panel>

      <RegistryEntryDetail entry={entry} onClose={() => undefined} open presentation="page" />
    </div>
  )
}
