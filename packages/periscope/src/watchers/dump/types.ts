/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The first application-owned frame above a call to `dump()`.
 */
export type DumpCaller = {
  file: string
  line: number
  column?: number
}

/**
 * The JSON-representable values captured by `dump()` and their call site, when available.
 */
export type DumpEntryContent = {
  values: unknown
  caller?: DumpCaller
}
