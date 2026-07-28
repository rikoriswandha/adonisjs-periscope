import { sequenceCompareAscending } from '../lib/format.ts'
import type { HttpClientContent, StoredEntry } from '../types.ts'

export type HttpClientDurationPoint = {
  /** Evenly spaced chart x-position (sample index), not wall-clock time. */
  sample: Date
  date: Date
  duration: number
  method: string
  path: string
  content: HttpClientContent
}

export function isHttpClientFailure(content: HttpClientContent): boolean {
  return content.error !== undefined && content.error !== null
}

export function buildHttpClientDurationData(entries: StoredEntry[]): HttpClientDurationPoint[] {
  const points = [...entries]
    .sort((left, right) => {
      const byDate = left.createdAt.localeCompare(right.createdAt)
      return byDate !== 0 ? byDate : sequenceCompareAscending(left.sequence, right.sequence)
    })
    .map((entry) => {
      const content = entry.content as HttpClientContent
      return {
        sample: new Date(0),
        date: new Date(entry.createdAt),
        duration: content.durationMs,
        method: content.method,
        path: content.url,
        content,
      }
    })
    .filter(
      (point) =>
        Number.isFinite(point.duration) &&
        (point.content.completed || isHttpClientFailure(point.content))
    )

  // Wall-clock timestamps often collide within a burst; space samples evenly
  // so the line stays readable oldest → newest.
  return points.map((point, index) => ({ ...point, sample: new Date(index) }))
}
