import { StatusDot, statusSignal, SIGNAL_TEXT } from '@/components/instrument'

/**
 * A status code repeats down every request column. Rendering 200 filled pills
 * turns the column into noise, so the dot carries the signal and the monospaced
 * figure carries the value.
 */
export function StatusBadge({ status }: { status: number | null | undefined }) {
  const signal = statusSignal(status)

  if (status === null || status === undefined) {
    return (
      <span className="inline-flex items-center gap-1.5 text-ink-4">
        <StatusDot signal="neutral" />
        <span className="num text-xs">···</span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot signal={signal} />
      <span className={`num text-xs font-medium ${SIGNAL_TEXT[signal]}`}>{status}</span>
    </span>
  )
}
