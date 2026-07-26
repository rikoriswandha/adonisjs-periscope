import { sequenceCompareAscending } from '../lib/format.ts'
import type { HttpClientContent, StoredEntry } from '../types.ts'

export type HttpClientDurationPoint = {
  date: Date
  duration: number
  label: string
  content: HttpClientContent
}

export function isHttpClientFailure(content: HttpClientContent): boolean {
  return content.error !== undefined && content.error !== null
}

export function buildHttpClientDurationData(entries: StoredEntry[]): HttpClientDurationPoint[] {
  return [...entries]
    .sort((left, right) => sequenceCompareAscending(left.sequence, right.sequence))
    .map((entry) => {
      const content = entry.content as HttpClientContent
      return {
        date: new Date(entry.createdAt),
        duration: content.durationMs,
        label: `${content.method} ${content.url}`,
        content,
      }
    })
    .filter(
      (point) =>
        Number.isFinite(point.duration) &&
        (point.content.completed || isHttpClientFailure(point.content))
    )
}
