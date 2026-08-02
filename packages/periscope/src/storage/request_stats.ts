/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Portable request-stat aggregation over the small scalar projection each SQL store reads.
 *
 * Exact percentiles are awkwardly different database machinery: postgres, MySQL and SQLite do
 * not share one percentile function, and grouping those functions behind three query shapes would
 * make the storage contract depend on the chosen connection. Instead every driver performs one
 * portable, newest-first read of the five request fields below and this module does the exact
 * arithmetic in process. {@link REQUEST_STATS_MAX_SAMPLES} bounds both that projection and the
 * sorting work, while keeping the stores free to avoid fetching the much larger content blobs.
 */

import type { RequestStatsBucket, RequestStatsResult } from '../types.ts'

/**
 * Hard row ceiling for one request-stat query. Drivers ask for one extra row solely to report
 * truncation, then keep the newest samples when a window exceeds the ceiling.
 */
export const REQUEST_STATS_MAX_SAMPLES = 50_000

/**
 * Maximum number of named route groups retained. The long tail is folded into the null group so
 * totals remain exact without allowing one high-cardinality URL field to dominate the response.
 */
export const REQUEST_STATS_MAX_GROUPS = 50

export type RequestStatsSample = {
  createdAtMs: number
  group: string | null
  durationMs: number | null
  error: boolean
}

type MutableBucket = {
  bucketStartMs: number
  group: string | null
  count: number
  errorCount: number
  durations: number[]
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function requestGroup(method: unknown, routePattern: unknown, url: unknown): string | null {
  const path =
    typeof routePattern === 'string' ? routePattern : typeof url === 'string' ? url : null

  return typeof method === 'string' && path !== null ? `${method} ${path}` : null
}

/**
 * Normalise one SQL projection. Drivers deliberately expose their native scalar result types;
 * Number coercion here is the single tolerant boundary for numeric strings and dialect values.
 */
export function requestStatsSampleFromRow(
  row: {
    createdAt: number | string
    duration: unknown
    status: unknown
    method: unknown
    routePattern: unknown
    url: unknown
  },
  grouped: boolean
): RequestStatsSample {
  const status = finiteNumber(row.status)

  return {
    createdAtMs: Number(row.createdAt),
    group: grouped ? requestGroup(row.method, row.routePattern, row.url) : null,
    durationMs: finiteNumber(row.duration),
    error: status !== null && status >= 500,
  }
}

/**
 * Give the memory driver the same normalisation boundary as SQL projections without serialising
 * or cloning its already-redacted content object.
 */
export function requestStatsSampleFromContent(
  content: Record<string, unknown>,
  createdAtMs: number,
  grouped: boolean
): RequestStatsSample {
  return requestStatsSampleFromRow(
    {
      createdAt: createdAtMs,
      duration: content.durationMs,
      status: content.status,
      method: content.method,
      routePattern: content.routePattern,
      url: content.url,
    },
    grouped
  )
}

function nearestRank(sorted: readonly number[], quantile: number): number | null {
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? null
}

/**
 * Aggregate a bounded set of request samples into non-empty cells. Window filtering belongs to
 * the stores: keeping it out of this loop makes the function an honest projection of the exact
 * rows the driver sampled, including its truncation boundary.
 */
export function aggregateRequestStats(options: {
  samples: RequestStatsSample[]
  fromMs: number
  bucketSeconds: number
  grouped: boolean
  truncated: boolean
}): RequestStatsResult {
  const widthMs = options.bucketSeconds * 1_000
  let retainedGroups: Set<string> | null = null

  if (options.grouped) {
    const groupCounts = new Map<string, number>()
    for (const sample of options.samples) {
      if (sample.group !== null) {
        groupCounts.set(sample.group, (groupCounts.get(sample.group) ?? 0) + 1)
      }
    }

    retainedGroups = new Set(
      [...groupCounts]
        .sort(
          ([leftGroup, leftCount], [rightGroup, rightCount]) =>
            rightCount - leftCount || leftGroup.localeCompare(rightGroup)
        )
        .slice(0, REQUEST_STATS_MAX_GROUPS)
        .map(([group]) => group)
    )
  }

  const cells = new Map<string, MutableBucket>()
  for (const sample of options.samples) {
    const bucketStartMs =
      options.fromMs + Math.floor((sample.createdAtMs - options.fromMs) / widthMs) * widthMs
    const group =
      options.grouped && sample.group !== null && retainedGroups?.has(sample.group)
        ? sample.group
        : null
    const key = `${bucketStartMs}\u0000${group ?? ''}`
    let cell = cells.get(key)

    if (cell === undefined) {
      cell = { bucketStartMs, group, count: 0, errorCount: 0, durations: [] }
      cells.set(key, cell)
    }

    cell.count += 1
    if (sample.error) cell.errorCount += 1
    if (sample.durationMs !== null) cell.durations.push(sample.durationMs)
  }

  const ordered = [...cells.values()].sort((left, right) => {
    const bucketOrder = left.bucketStartMs - right.bucketStartMs
    if (bucketOrder !== 0) return bucketOrder
    if (left.group === null) return right.group === null ? 0 : 1
    if (right.group === null) return -1
    return left.group.localeCompare(right.group)
  })
  const buckets: RequestStatsBucket[] = ordered.map((cell) => {
    cell.durations.sort((left, right) => left - right)

    return {
      bucketStart: new Date(cell.bucketStartMs).toISOString(),
      group: cell.group,
      count: cell.count,
      errorCount: cell.errorCount,
      p50: nearestRank(cell.durations, 0.5),
      p95: nearestRank(cell.durations, 0.95),
    }
  })

  return {
    buckets,
    sampled: options.samples.length,
    truncated: options.truncated,
  }
}
