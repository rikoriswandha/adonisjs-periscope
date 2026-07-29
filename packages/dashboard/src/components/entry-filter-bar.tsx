import { Clock3, Plus, X } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  dateTimeLocalValue,
  entryUrlFilterState,
  isoDateTime,
  normalizeExactTag,
  presetTimeRange,
} from '@/lib/global-search'

const presets = [
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: '24h', minutes: 1_440 },
] as const

export function EntryFilterBar() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [tagInput, setTagInput] = useState('')
  const { tags, from, to } = entryUrlFilterState(searchParams)
  const fromInput = dateTimeLocalValue(from)
  const toInput = dateTimeLocalValue(to)
  const activeMinutes =
    from && to ? Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000) : null

  const addTag = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const tag = normalizeExactTag(tagInput)
    if (!tag) return
    if (!tags.includes(tag)) {
      const next = new URLSearchParams(searchParams)
      next.append('tag', tag)
      setSearchParams(next)
    }
    setTagInput('')
  }

  return (
    <section
      aria-label="Entry filters"
      className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 lg:flex-row lg:items-end lg:justify-between"
    >
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs font-medium" htmlFor="entry-filter-tag">
            Exact tags
          </label>
          {tags.length > 0 && (
            <Button
              onClick={() => {
                const next = new URLSearchParams(searchParams)
                next.delete('tag')
                setSearchParams(next)
              }}
              size="xs"
              type="button"
              variant="ghost"
            >
              Clear tags
            </Button>
          )}
        </div>
        <form className="flex max-w-xl items-center gap-2" onSubmit={addTag}>
          <Input
            autoComplete="off"
            id="entry-filter-tag"
            onChange={(event) => setTagInput(event.target.value)}
            placeholder="Add an exact tag"
            type="text"
            value={tagInput}
          />
          <Button disabled={!normalizeExactTag(tagInput)} size="sm" type="submit" variant="outline">
            <Plus aria-hidden="true" />
            Add
          </Button>
        </form>
        {tags.length > 0 && (
          <div aria-label="Active exact tags" className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                <span className="font-mono">{tag}</span>
                <button
                  aria-label={`Remove exact tag ${tag}`}
                  className="-me-1 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams)
                    next.delete('tag')
                    for (const activeTag of tags) {
                      if (activeTag !== tag) next.append('tag', activeTag)
                    }
                    setSearchParams(next)
                  }}
                  type="button"
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="me-1 flex items-center gap-1.5 text-xs font-medium">
            <Clock3 aria-hidden="true" className="size-3.5 text-muted-foreground" />
            Time range
          </span>
          {presets.map((preset) => (
            <Button
              aria-pressed={activeMinutes === preset.minutes}
              key={preset.label}
              onClick={() => {
                const next = new URLSearchParams(searchParams)
                const range = presetTimeRange(preset.minutes)
                next.set('from', range.from)
                next.set('to', range.to)
                setSearchParams(next)
              }}
              size="xs"
              type="button"
              variant={activeMinutes === preset.minutes ? 'secondary' : 'ghost'}
            >
              {preset.label}
            </Button>
          ))}
          {(from || to) && (
            <Button
              onClick={() => {
                const next = new URLSearchParams(searchParams)
                next.delete('from')
                next.delete('to')
                setSearchParams(next)
              }}
              size="xs"
              type="button"
              variant="ghost"
            >
              Clear
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 text-2xs text-muted-foreground">
            From
            <Input
              aria-label="Entries created from"
              max={toInput || undefined}
              nativeInput
              onChange={(event) => {
                const next = new URLSearchParams(searchParams)
                const value = isoDateTime(event.target.value)
                if (value) next.set('from', value)
                else next.delete('from')
                setSearchParams(next)
              }}
              size="sm"
              type="datetime-local"
              value={fromInput}
            />
          </label>
          <label className="flex items-center gap-2 text-2xs text-muted-foreground">
            To
            <Input
              aria-label="Entries created through"
              min={fromInput || undefined}
              nativeInput
              onChange={(event) => {
                const next = new URLSearchParams(searchParams)
                const value = isoDateTime(event.target.value)
                if (value) next.set('to', value)
                else next.delete('to')
                setSearchParams(next)
              }}
              size="sm"
              type="datetime-local"
              value={toInput}
            />
          </label>
        </div>
      </div>
    </section>
  )
}
