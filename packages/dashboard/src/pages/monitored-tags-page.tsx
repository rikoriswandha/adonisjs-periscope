import { BellRing, Search } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { PageHeader } from '@/components/page-header'
import { TagChip } from '@/components/tag-chip'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { useDashboard } from '@/dashboard-context'

const TAG_MAX_LENGTH = 191

function tagValidationMessage(tag: string): string | null {
  if (tag.length === 0) return 'Enter a tag to monitor.'
  if (tag.length > TAG_MAX_LENGTH) {
    return `Tag must contain between 1 and ${TAG_MAX_LENGTH} characters.`
  }
  return null
}

export function MonitoredTagsPage() {
  const { monitoredTags, monitoredTagsReady, monitoringTags, toggleTagMonitoring } = useDashboard()
  const [value, setValue] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const tag = value.trim()
  const alreadyMonitored = monitoredTags.includes(tag)
  const submitting = monitoringTags.includes(tag)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const error = tagValidationMessage(tag)
    if (error) {
      setValidationError(error)
      return
    }
    if (alreadyMonitored) {
      setValidationError('This exact tag is already monitored.')
      return
    }

    setValidationError(null)
    await toggleTagMonitoring(tag)
    setValue('')
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Monitored tags"
        description="Keep sampled-out request batches when any entry carries one of these exact tags."
      />

      <form className="rounded-md border bg-card p-3 sm:p-4" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 text-xs font-medium">
            Exact tag
            <Input
              aria-describedby={validationError ? 'monitored-tag-error' : 'monitored-tag-help'}
              aria-invalid={validationError ? true : undefined}
              autoComplete="off"
              className="mt-1.5"
              maxLength={TAG_MAX_LENGTH + 1}
              nativeInput
              onChange={(event) => {
                setValue(event.target.value)
                if (validationError) setValidationError(null)
              }}
              placeholder="e.g. tenant:acme"
              value={value}
            />
          </label>
          <Button disabled={!monitoredTagsReady || submitting} loading={submitting} type="submit">
            <BellRing aria-hidden="true" />
            Monitor tag
          </Button>
        </div>
        {validationError ? (
          <p className="mt-2 text-xs text-destructive-foreground" id="monitored-tag-error" role="alert">
            {validationError}
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground" id="monitored-tag-help">
            Tags are case-sensitive and may contain up to {TAG_MAX_LENGTH} characters.
          </p>
        )}
      </form>

      {!monitoredTagsReady ? (
        <div className="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground" role="status">
          Loading monitored tags…
        </div>
      ) : monitoredTags.length === 0 ? (
        <Empty className="rounded-md border bg-muted/25">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BellRing aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No monitored tags</EmptyTitle>
            <EmptyDescription>
              Sampling normally discards selected request batches. Monitor an exact tag to retain a
              sampled-out batch whenever one of its entries carries that tag.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <section aria-label="Monitored exact tags" className="overflow-hidden rounded-md border">
          <ul className="divide-y">
            {monitoredTags.map((monitoredTag) => (
              <li className="flex min-w-0 items-center gap-3 px-3 py-2.5 sm:px-4" key={monitoredTag}>
                <div className="min-w-0 flex-1">
                  <TagChip tag={monitoredTag} />
                </div>
                <Button
                  aria-label={`Search entries tagged ${monitoredTag}`}
                  render={<Link to={`/search?tag=${encodeURIComponent(monitoredTag)}`} />}
                  size="sm"
                  variant="ghost"
                >
                  <Search aria-hidden="true" />
                  <span className="hidden sm:inline">Search</span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
