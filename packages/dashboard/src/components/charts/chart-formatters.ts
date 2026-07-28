export const shortDateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
})

export const weekdayDateFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

export const hmsTimeFmt = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export const shortDateTimeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function sameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

/**
 * Axis / ticker labels for a time series. Same-day samples use clock time so
 * evenly spaced bursts stay distinguishable; multi-day series keep the short
 * date unless that would collide, in which case date+time is used.
 */
export function formatChartDateLabels(dates: readonly Date[]): string[] {
  if (dates.length === 0) return []

  const first = dates[0]
  if (!first) return []

  if (dates.every((date) => sameLocalDay(date, first))) {
    return dates.map((date) => hmsTimeFmt.format(date))
  }

  const shortLabels = dates.map((date) => shortDateFmt.format(date))
  if (new Set(shortLabels).size === shortLabels.length) {
    return shortLabels
  }

  return dates.map((date) => shortDateTimeFmt.format(date))
}

// `Intl.NumberFormat.prototype.format` is a bound getter — safe to extract.
export const intFmt = new Intl.NumberFormat('en-US').format
