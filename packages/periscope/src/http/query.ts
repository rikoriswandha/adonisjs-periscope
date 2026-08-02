/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Keep only unambiguous, real ISO datetimes. Invalid filters are omitted rather than turning a
 * dashboard typo into an API error or an empty result set.
 */
export function validIsoDateTime(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const match = ISO_DATETIME.exec(value)
  if (match === null) {
    return undefined
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])
  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month, 0)

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > calendar.getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    return undefined
  }

  return value
}

/**
 * Read one query-string value while tolerating parsers that retain repeated values as arrays.
 */
export function firstQueryString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0]
  }

  return undefined
}
