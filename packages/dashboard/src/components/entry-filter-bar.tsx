import { Clock3, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxValue,
} from '@/components/ui/combobox'
import { DatePicker } from '@/components/ui/date-picker'
import { Group, GroupText } from '@/components/ui/group'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Toolbar, ToolbarGroup, ToolbarSeparator } from '@/components/ui/toolbar'
import {
  endOfLocalDayIso,
  entryUrlFilterState,
  normalizeExactTag,
  parseFilterDate,
  presetTimeRange,
  startOfLocalDayIso,
} from '@/lib/global-search'

const presets = [
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: '24h', minutes: 1_440 },
] as const

type TagOption = { label: string; value: string }

export function EntryFilterBar() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [tagInput, setTagInput] = useState('')
  const { tags, from, to } = entryUrlFilterState(searchParams)
  const fromDate = parseFilterDate(from)
  const toDate = parseFilterDate(to)
  const liveTail = searchParams.get('tail') === '1'
  const activeMinutes =
    from && to ? Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000) : null
  const activePreset = presets.find((preset) => preset.minutes === activeMinutes)?.label ?? ''
  const tagOptions = useMemo<TagOption[]>(
    () => tags.map((tag) => ({ label: tag, value: tag })),
    [tags]
  )
  const activeFilterCount = tags.length + (from || to ? 1 : 0)

  const replaceTags = (nextTags: string[]) => {
    const next = new URLSearchParams(searchParams)
    next.delete('tag')
    for (const tag of nextTags) next.append('tag', tag)
    setSearchParams(next)
  }

  const commitTag = () => {
    const tag = normalizeExactTag(tagInput)
    if (!tag) return
    if (!tags.includes(tag)) replaceTags([...tags, tag])
    setTagInput('')
  }

  const handleTagKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commitTag()
  }

  const clearFilters = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('tag')
    next.delete('from')
    next.delete('to')
    setSearchParams(next)
    setTagInput('')
  }

  return (
    <section aria-label="Entry filters">
      <Toolbar className="well flex-wrap gap-2 rounded-sm border-edge bg-well p-2 text-ink max-sm:items-stretch">
        <ToolbarGroup className="min-w-52 flex-1 max-sm:w-full">
          <Combobox
            items={tagOptions}
            inputValue={tagInput}
            multiple
            onInputValueChange={setTagInput}
            onValueChange={(value) => replaceTags(value.map((option) => option.value))}
            value={tagOptions}
          >
            <ComboboxChips className="min-h-[var(--control-h)] rounded-sm border-edge bg-panel p-0.5 shadow-none pointer-coarse:min-h-11" startAddon={<Search />}>
              <ComboboxValue>
                {(value: TagOption[]) => (
                  <>
                    {value.map((option) => (
                      <ComboboxChip aria-label={option.label} key={option.value}>
                        <span className="num max-w-40 truncate">{option.label}</span>
                      </ComboboxChip>
                    ))}
                    <ComboboxChipsInput
                      aria-label="Filter by exact tags"
                      className="num h-[var(--control-h)] text-xs text-ink placeholder:text-ink-3"
                      onKeyDown={handleTagKeyDown}
                      placeholder={tags.length > 0 ? 'Add tag…' : 'Filter exact tags…'}
                      size="sm"
                    />
                  </>
                )}
              </ComboboxValue>
            </ComboboxChips>
            <ComboboxPopup className="rounded-sm">
              <ComboboxEmpty>
                {normalizeExactTag(tagInput) ? 'Press Enter to add this exact tag.' : 'Type an exact tag.'}
              </ComboboxEmpty>
              <ComboboxList>
                {(option: TagOption) => (
                  <ComboboxItem key={option.value} value={option}>
                    <span className="num">{option.label}</span>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxPopup>
          </Combobox>
        </ToolbarGroup>

        <ToolbarSeparator className="max-sm:hidden" orientation="vertical" />

        <ToolbarGroup className="flex-wrap gap-1.5 max-sm:w-full">
          <Group aria-label="Time range presets">
            <GroupText className="rounded-sm border-edge bg-panel px-2 text-xs text-ink-3 shadow-none">
              <Clock3 aria-hidden="true" className="size-3.5" />
              Range
            </GroupText>
            <ToggleGroup
              aria-label="Time range"
              className="w-auto"
              size="sm"
              onValueChange={(value) => {
                const selected = value[0]
                if (!selected) return
                const preset = presets.find((candidate) => candidate.label === selected)
                if (!preset) return
                const next = new URLSearchParams(searchParams)
                const range = presetTimeRange(preset.minutes)
                next.set('from', range.from)
                next.set('to', range.to)
                setSearchParams(next)
              }}
              value={activePreset ? [activePreset] : []}
              variant="outline"
            >
              {presets.map((preset) => (
                <ToggleGroupItem
                  className="num min-w-10 rounded-sm px-2 text-xs"
                  key={preset.label}
                  value={preset.label}
                >
                  {preset.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Group>

          <Group aria-label="Custom time range" className="max-sm:w-full max-sm:flex-wrap">
            <DatePicker
              aria-label="Entries created from"
              className="h-[var(--control-h)] w-36 rounded-sm text-xs"
              disabled={toDate ? { after: toDate } : undefined}
              onChange={(date) => {
                const next = new URLSearchParams(searchParams)
                if (date) next.set('from', startOfLocalDayIso(date))
                else next.delete('from')
                setSearchParams(next)
              }}
              placeholder="From date"
              value={fromDate}
            />
            <DatePicker
              aria-label="Entries created through"
              className="h-[var(--control-h)] w-36 rounded-sm text-xs"
              disabled={fromDate ? { before: fromDate } : undefined}
              onChange={(date) => {
                const next = new URLSearchParams(searchParams)
                if (date) next.set('to', endOfLocalDayIso(date))
                else next.delete('to')
                setSearchParams(next)
              }}
              placeholder="To date"
              value={toDate}
            />
          </Group>
        </ToolbarGroup>

        <ToolbarSeparator className="max-lg:hidden" orientation="vertical" />

        <ToolbarGroup className="ms-auto gap-2 max-sm:ms-0 max-sm:w-full max-sm:justify-between">
          <label className="flex h-[var(--control-h)] items-center gap-2 rounded-sm px-1.5 text-xs text-ink-2 pointer-coarse:min-h-11">
            Live tail
            <Switch
              aria-label="Automatically show new entries"
              checked={liveTail}
              onCheckedChange={(checked) => {
                const next = new URLSearchParams(searchParams)
                if (checked) next.set('tail', '1')
                else next.delete('tail')
                setSearchParams(next)
              }}
            />
          </label>
          {activeFilterCount > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="num text-micro text-ink-3" role="status">
                {activeFilterCount} active
              </span>
              <Button
                aria-label={`Clear ${activeFilterCount} active ${activeFilterCount === 1 ? 'filter' : 'filters'}`}
                className="h-[var(--control-h)] rounded-sm px-2"
                onClick={clearFilters}
                size="xs"
                type="button"
                variant="ghost"
              >
                <X aria-hidden="true" />
                Clear
              </Button>
            </div>
          )}
        </ToolbarGroup>
      </Toolbar>
    </section>
  )
}
