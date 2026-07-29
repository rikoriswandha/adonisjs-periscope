import { ArrowLeft, CircleAlert, Files } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { RegistryEntryDetail } from '@/entry-type-registry'
import { api, ApiError } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import type { StoredEntry } from '@/types'
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

      <RegistryEntryDetail
        entry={entry}
        onClose={() => undefined}
        open
        presentation="page"
      />
    </div>
  )
}
