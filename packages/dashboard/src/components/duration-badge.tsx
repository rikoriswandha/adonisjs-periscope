import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Durations are read as a column, not as individual values, so they are
 * monospaced, figure-aligned, and tinted only when they cross the slow
 * threshold. A tinted row in an otherwise achromatic column is the whole point.
 */
export function DurationBadge({
  value,
  slow = false,
}: {
  value: number | undefined | null
  slow?: boolean
}) {
  return (
    <span
      className={cn(
        'num text-xs tracking-tight tabular-nums',
        slow ? 'font-medium text-sig-warn' : 'text-ink-2'
      )}
      title={slow ? 'Slower than the configured threshold' : undefined}
    >
      {formatDuration(value)}
    </span>
  )
}
