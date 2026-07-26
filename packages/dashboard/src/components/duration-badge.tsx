import { Badge } from '@/components/ui/badge'
import { formatDuration } from '@/lib/format'

export function DurationBadge({
  value,
  slow = false,
}: {
  value: number | undefined | null
  slow?: boolean
}) {
  return (
    <Badge className="font-mono tabular-nums" variant={slow ? 'warning' : 'secondary'}>
      {formatDuration(value)}
    </Badge>
  )
}
