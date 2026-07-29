import { ENTRY_TYPES } from '../types.ts'
import type { EntryFilters, EntryType } from '../types.ts'

export type EntryUrlFilterState = {
  text?: string
  tags: string[]
  type?: EntryType
  from?: string
  to?: string
}

function normalizeText(value: string | null | undefined): string | undefined {
  const text = value?.trim()
  return text || undefined
}

export function normalizeExactTag(value: string | null | undefined): string | undefined {
  return normalizeText(value)
}

export function normalizeExactTags(values: Iterable<string | null | undefined>): string[] {
  const tags = new Set<string>()
  for (const value of values) {
    const tag = normalizeExactTag(value)
    if (tag) tags.add(tag)
  }
  return [...tags]
}

function normalizeEntryType(value: string | null): EntryType | undefined {
  return ENTRY_TYPES.includes(value as EntryType) ? (value as EntryType) : undefined
}

function normalizeIsoDate(value: string | null): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function entryUrlFilterState(searchParams: URLSearchParams): EntryUrlFilterState {
  return {
    text: normalizeText(searchParams.get('text')),
    tags: normalizeExactTags(searchParams.getAll('tag')),
    type: normalizeEntryType(searchParams.get('type')),
    from: normalizeIsoDate(searchParams.get('from')),
    to: normalizeIsoDate(searchParams.get('to')),
  }
}

export function globalSearchTarget(value: string): string {
  const text = normalizeText(value)
  return text ? `/search?text=${encodeURIComponent(text)}` : '/search'
}

export function globalSearchFilters(searchParams: URLSearchParams): EntryFilters | null {
  const { text, tags, type, from, to } = entryUrlFilterState(searchParams)
  if (!text && tags.length === 0 && !type && !from && !to) return null

  return {
    text,
    tags: tags.length > 0 ? tags : undefined,
    type,
    from,
    to,
    displayOnIndex: true,
    limit: 50,
  }
}

export function parseFilterDate(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function startOfLocalDayIso(date: Date): string {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return next.toISOString()
}

export function endOfLocalDayIso(date: Date): string {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
  return next.toISOString()
}

export function presetTimeRange(
  minutes: 15 | 60 | 1_440,
  now: Date = new Date()
): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - minutes * 60_000).toISOString(),
    to: now.toISOString(),
  }
}
