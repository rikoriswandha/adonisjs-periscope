export function formatDuration(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  if (value < 1) return `${value.toFixed(2)} ms`
  if (value < 1_000) return `${value.toFixed(value < 10 ? 1 : 0)} ms`
  return `${(value / 1_000).toFixed(2)} s`
}

export function formatBytes(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  const sign = value < 0 ? '−' : value > 0 ? '+' : ''
  if (absolute < 1_024) return `${sign}${absolute} B`
  if (absolute < 1_048_576) return `${sign}${(absolute / 1_024).toFixed(1)} KiB`
  return `${sign}${(absolute / 1_048_576).toFixed(1)} MiB`
}

export function formatRelativeTime(iso: string): string {
  const timestamp = new Date(iso).getTime()
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1_000)
  const absolute = Math.abs(deltaSeconds)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (absolute < 60) return formatter.format(deltaSeconds, 'second')
  if (absolute < 3_600) return formatter.format(Math.round(deltaSeconds / 60), 'minute')
  if (absolute < 86_400) return formatter.format(Math.round(deltaSeconds / 3_600), 'hour')
  return formatter.format(Math.round(deltaSeconds / 86_400), 'day')
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(iso))
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asString(value: unknown, fallback = '—'): string {
  return typeof value === 'string' ? value : fallback
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function sequenceCompareAscending(a: string, b: string): number {
  const left = BigInt(a)
  const right = BigInt(b)
  return left < right ? -1 : left > right ? 1 : 0
}

export function truncate(value: string, limit = 96): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}
