/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Cursor and page-size handling, shared by every storage driver.
 *
 * These rules are part of the storage contract rather than of any one driver: a dashboard screen
 * pages through `memory` in a unit test and through `sqlite-local` in the application it is
 * debugging, and the two must clamp, reject and terminate identically. Keeping them in one module
 * is what makes "the contract suite passes against every driver" a statement about behaviour and
 * not a coincidence of three separate implementations.
 */

/**
 * Page size used when a query asks for none — or asks for a nonsensical one. A dashboard screen
 * shows a hundred rows; anything more is a scroll nobody reads.
 */
export const DEFAULT_PAGE_SIZE = 100

/**
 * Hard ceiling on a page. A caller can put whatever it likes in a query string; the driver, not
 * the caller, decides how much of the store it is willing to copy out in one go.
 */
export const MAX_PAGE_SIZE = 1_000

/**
 * A cursor is the previous page's last `sequence` rendered in decimal. Anything else — a
 * truncated string, something a user typed, a cursor from a store that has since been cleared —
 * is ignored rather than rejected: a stale cursor should show the first page, not an error page.
 */
const CURSOR_PATTERN = /^\d+$/

/**
 * Render a cursor for the last entry of a page.
 */
export function encodeCursor(sequence: bigint): string {
  return sequence.toString()
}

/**
 * Turn a cursor from {@link Paginated.nextCursor} back into the sequence to page below, or
 * `null` when there is nothing usable to page below.
 */
export function parseCursor(cursor: string | undefined): bigint | null {
  if (cursor === undefined || !CURSOR_PATTERN.test(cursor)) {
    return null
  }

  return BigInt(cursor)
}

/**
 * A durable entry cursor uses the row's primary key as a deterministic tie-breaker. Sequence
 * values are process-local, so two workers may legitimately stamp the same value.
 */
export type EntryCursor = {
  sequence: bigint
  uuid: string | null
}

/**
 * Encode the composite ordering key of an entry. The UUID is URI-escaped so custom store
 * implementations remain free to use identifiers containing the separator.
 */
export function encodeEntryCursor(sequence: bigint, uuid: string): string {
  return `${sequence}:${encodeURIComponent(uuid)}`
}

/**
 * Parse a composite entry cursor. Decimal-only cursors emitted by older releases remain valid;
 * they page strictly below their sequence and therefore preserve the old behaviour.
 */
export function parseEntryCursor(cursor: string | undefined): EntryCursor | null {
  if (cursor === undefined) {
    return null
  }

  const separator = cursor.indexOf(':')
  if (separator === -1) {
    return CURSOR_PATTERN.test(cursor) ? { sequence: BigInt(cursor), uuid: null } : null
  }

  const sequence = cursor.slice(0, separator)
  const encodedUuid = cursor.slice(separator + 1)
  if (!CURSOR_PATTERN.test(sequence) || encodedUuid === '') {
    return null
  }

  try {
    const uuid = decodeURIComponent(encodedUuid)
    return uuid === '' ? null : { sequence: BigInt(sequence), uuid }
  } catch {
    return null
  }
}

/**
 * Clamp a requested page size into `[1, MAX_PAGE_SIZE]`, falling back to the default for a
 * missing, non-finite or non-positive request. A `limit: 0` that was honoured literally would
 * page forever, so it is treated as "unspecified".
 */
export function resolvePageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_PAGE_SIZE
  }

  return Math.min(Math.floor(limit), MAX_PAGE_SIZE)
}
