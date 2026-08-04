import { BellRing, Search } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { Panel, PanelBody, PanelHeader } from '@/components/instrument'
import { PageHeader } from '@/components/page-header'
import { TagChip } from '@/components/tag-chip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
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

      <Panel>
        <PanelHeader icon={<BellRing aria-hidden="true" />} title="Add an exact tag" />
        <PanelBody>
          <form onSubmit={(event) => void submit(event)}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1 text-xs font-medium text-ink-2">
                Exact tag
                <Input
                  aria-describedby={validationError ? 'monitored-tag-error' : 'monitored-tag-help'}
                  aria-invalid={validationError ? true : undefined}
                  autoComplete="off"
                  className="num mt-1.5 h-[var(--control-h)] items-center rounded-sm border-edge bg-well text-sm text-ink shadow-none placeholder:text-ink-3 max-sm:text-md [@media(pointer:coarse)]:h-11"
                  maxLength={TAG_MAX_LENGTH + 1}
                  nativeInput
                  onChange={(event) => {
                    setValue(event.target.value)
                    if (validationError) setValidationError(null)
                  }}
                  placeholder="e.g. tenant:acme"
                  size="sm"
                  value={value}
                />
              </label>
              <Button
                className="h-[var(--control-h)] rounded-sm sm:h-[var(--control-h)]"
                disabled={!monitoredTagsReady || submitting}
                loading={submitting}
                type="submit"
              >
                <BellRing aria-hidden="true" />
                Monitor tag
              </Button>
            </div>
            {validationError ? (
              <p className="mt-2 text-xs text-sig-error" id="monitored-tag-error" role="alert">
                {validationError}
              </p>
            ) : (
              <p className="mt-2 text-xs text-ink-3" id="monitored-tag-help">
                Tags are case-sensitive and may contain up to{' '}
                <span className="num">{TAG_MAX_LENGTH}</span> characters.
              </p>
            )}
          </form>
        </PanelBody>
      </Panel>

      {!monitoredTagsReady ? (
        <Panel aria-label="Loading monitored tags" aria-live="polite" role="status">
          <PanelHeader meta="Loading" title="Monitored exact tags" />
          <PanelBody className="space-y-2">
            {[52, 68, 44].map((width) => (
              <div className="flex min-h-[var(--row-h)] items-center justify-between gap-3" key={width}>
                <Skeleton className="h-5 rounded-sm" style={{ width: `${width}%` }} />
                <Skeleton className="h-[var(--control-h)] w-20 rounded-sm" />
              </div>
            ))}
          </PanelBody>
        </Panel>
      ) : monitoredTags.length === 0 ? (
        <Panel aria-labelledby="monitored-tags-empty-title">
          <PanelHeader title="How tag monitoring works" />
          <PanelBody className="flex flex-col gap-4 py-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-[70ch] space-y-2">
              <h2 className="text-md font-medium text-ink" id="monitored-tags-empty-title">
                Keep important batches even when sampling would discard them
              </h2>
              <p className="text-prose text-ink-2">
                When any recorded entry in a request batch carries an exact monitored tag, Periscope
                retains that batch instead of sampling it out. Matching is case-sensitive.
              </p>
              <p className="text-sm text-ink-3">
                A tag gets recorded when your application attaches it to an entry. Open a recording to
                see its tags, then monitor the exact value here or directly from its tag chip.
              </p>
            </div>
            <Button
              className="h-[var(--control-h)] rounded-sm sm:h-[var(--control-h)]"
              render={<Link to="/search" />}
              variant="outline"
            >
              <Search aria-hidden="true" />
              Find recorded tags
            </Button>
          </PanelBody>
        </Panel>
      ) : (
        <Panel aria-label="Monitored exact tags">
          <PanelHeader
            meta={`${monitoredTags.length.toLocaleString()} monitored`}
            title="Monitored exact tags"
          />
          <PanelBody className="p-0">
            <ul className="well divide-y divide-edge rounded-none border-0">
              {monitoredTags.map((monitoredTag) => (
                <li
                  className="flex min-h-[var(--row-h)] min-w-0 items-center gap-3 px-3 py-[var(--cell-py)]"
                  key={monitoredTag}
                >
                  <div className="min-w-0 flex-1 pointer-coarse:[&>button]:min-h-11">
                    <TagChip tag={monitoredTag} />
                  </div>
                  <Button
                    aria-label={`Search entries tagged ${monitoredTag}`}
                    className="h-[var(--control-h)] rounded-sm"
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
          </PanelBody>
        </Panel>
      )}
    </div>
  )
}
