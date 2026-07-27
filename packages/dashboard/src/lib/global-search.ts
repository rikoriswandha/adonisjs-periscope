import type { EntryFilters } from '../types.ts'

export function normalizeExactTag(value: string | null | undefined): string | undefined {
  const tag = value?.trim()
  return tag || undefined
}

export function globalSearchTarget(value: string): string {
  const tag = normalizeExactTag(value)
  return tag ? `/search?tag=${encodeURIComponent(tag)}` : '/search'
}

export function globalSearchFilters(value: string | null | undefined): EntryFilters | null {
  const tag = normalizeExactTag(value)
  return tag ? { tag, displayOnIndex: true, limit: 50 } : null
}
