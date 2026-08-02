const TREND_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Keeps trend calculation independent from rendering so the 24-hour boundary behavior stays
 * deterministic and can be defended without a charting dependency.
 */
export function bucketExceptionOccurrences(
  entries: ReadonlyArray<{ createdAt: string }>,
  now = Date.now(),
  bucketCount = 12
): number[] {
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) return []

  const buckets = Array.from({ length: bucketCount }, () => 0)
  const windowStart = now - TREND_WINDOW_MS
  const bucketWidth = TREND_WINDOW_MS / bucketCount

  for (const entry of entries) {
    const timestamp = new Date(entry.createdAt).getTime()
    if (!Number.isFinite(timestamp) || timestamp < windowStart || timestamp > now) continue
    const index = Math.min(bucketCount - 1, Math.floor((timestamp - windowStart) / bucketWidth))
    buckets[index] += 1
  }

  return buckets
}
