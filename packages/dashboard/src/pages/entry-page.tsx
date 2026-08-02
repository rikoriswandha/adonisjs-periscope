import { ArrowLeft, CircleAlert, Files, Pin } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
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
            No recorded entry has UUID {uuid}. It may have expired under the retention policy.
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
            <label className="flex min-h-7 items-center gap-2 rounded-md border bg-background px-2 text-xs font-medium">
              <Pin
                aria-hidden="true"
                className={`size-3.5 ${metadata.pinned ? 'fill-current text-primary' : ''}`}
              />
              Pinned
              <Switch
                aria-label="Pin this entry"
                checked={metadata.pinned}
                disabled={metadataLoading || metadataSaving}
                onCheckedChange={(pinned) => void updateMetadata({ pinned })}
              />
            </label>
            <Badge variant="secondary">{entryTypeLabel(entry.type)}</Badge>
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
        description={`${formatDateTime(entry.createdAt)} · ${entry.uuid}`}
        title={`${entryTypeLabel(entry.type)} entry`}
      />

      <section
        aria-busy={metadataLoading || metadataSaving}
        aria-labelledby="entry-note-title"
        className="space-y-3 rounded-lg border bg-card p-4"
      >
        <div>
          <h2 className="text-sm font-semibold" id="entry-note-title">
            Note
          </h2>
          <p className="text-xs text-muted-foreground">
            Add private context for this recorded entry. Notes are limited to 2,000 characters.
          </p>
        </div>
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
          <span className="text-2xs tabular-nums text-muted-foreground">
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
          <p className="text-xs text-destructive-foreground" role="alert">
            {metadataError.message}
          </p>
        )}
      </section>

      <RegistryEntryDetail entry={entry} onClose={() => undefined} open presentation="page" />
    </div>
  )
}
