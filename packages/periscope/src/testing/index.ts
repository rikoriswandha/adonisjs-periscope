/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import type { Recorder } from '../recorder/recorder.ts'
import type { EntryType, StoredEntry } from '../types.ts'

export { periscopePlugin } from './japa_plugin.ts'
export type {
  PeriscopePluginOptions,
  PeriscopeTestContext,
  PeriscopeTestingApi,
} from './japa_plugin.ts'

const DEFAULT_TIMEOUT_MS = 2_000
const DEFAULT_INTERVAL_MS = 10
const PAGE_SIZE = 100

export type RecordedEntryMatcher = {
  type?: EntryType
  application?: string
  batchId?: string
  /** Every tag must be present on the entry. */
  tags?: readonly string[]
  predicate?: (entry: StoredEntry) => boolean
}

export type WaitForRecordedOptions = {
  timeoutMs?: number
  intervalMs?: number
}

export type EntriesPredicate = (entries: StoredEntry[]) => boolean

function normalizeOptions(options: WaitForRecordedOptions = {}): Required<WaitForRecordedOptions> {
  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
  }
}

function describeMatcher(matcher: RecordedEntryMatcher): string {
  const parts: string[] = []

  if (matcher.type !== undefined) parts.push(`type=${matcher.type}`)
  if (matcher.application !== undefined) parts.push(`application=${matcher.application}`)
  if (matcher.batchId !== undefined) parts.push(`batchId=${matcher.batchId}`)
  if (matcher.tags !== undefined) parts.push(`tags=[${matcher.tags.join(', ')}]`)
  if (matcher.predicate !== undefined) parts.push('predicate=<custom>')

  return parts.length > 0 ? parts.join(', ') : 'any entry'
}

function describeEntries(entries: StoredEntry[]): string {
  if (entries.length === 0) return 'none'

  const shown = entries
    .slice(0, 5)
    .map((entry) => `${entry.type}${entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''}`)
    .join('; ')
  const remainder = entries.length > 5 ? `; and ${entries.length - 5} more` : ''

  return `${shown}${remainder}`
}

/** Fetch all entries matching the storage-backed fields, then apply the optional predicate. */
export async function findEntries(
  recorder: Recorder,
  matcher: RecordedEntryMatcher
): Promise<StoredEntry[]> {
  const entries: StoredEntry[] = []
  let cursor: string | undefined

  do {
    const page = await recorder.mute(() =>
      recorder.store.list({
        type: matcher.type,
        application: matcher.application,
        batchId: matcher.batchId,
        tags: matcher.tags === undefined ? undefined : [...matcher.tags],
        cursor,
        limit: PAGE_SIZE,
      })
    )

    entries.push(...page.data)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)

  return matcher.predicate === undefined ? entries : entries.filter(matcher.predicate)
}

/** Flush buffered entries and keep flushing/polling until `predicate` accepts the stored entries. */
export async function flushAndWait(
  recorder: Recorder,
  predicate: EntriesPredicate = (entries) => entries.length > 0,
  options: WaitForRecordedOptions = {}
): Promise<StoredEntry[]> {
  const { timeoutMs, intervalMs } = normalizeOptions(options)
  const deadline = Date.now() + timeoutMs
  let entries: StoredEntry[] = []

  do {
    await recorder.flush()
    entries = await findEntries(recorder, {})

    if (predicate(entries)) return entries
    if (Date.now() >= deadline) break

    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
  } while (Date.now() <= deadline)

  throw new Error(
    `Periscope did not record the expected entries within ${timeoutMs}ms. ` +
      `Observed entries: ${describeEntries(entries)}.`
  )
}

/** Wait until at least one matching entry has settled in storage. */
export async function assertRecorded(
  recorder: Recorder,
  matcher: RecordedEntryMatcher,
  options: WaitForRecordedOptions = {}
): Promise<StoredEntry[]> {
  let matches: StoredEntry[] = []

  try {
    await flushAndWait(
      recorder,
      (entries) => {
        matches = entries.filter((entry) => matchesEntry(entry, matcher))
        return matches.length > 0
      },
      options
    )
  } catch (error) {
    if (!(error instanceof Error)) throw error

    throw new Error(
      `Expected Periscope to record an entry matching ${describeMatcher(matcher)}. ${error.message}`,
      { cause: error }
    )
  }

  return matches
}

/** Hold the complete settling window and fail as soon as a matching entry appears. */
export async function assertNotRecorded(
  recorder: Recorder,
  matcher: RecordedEntryMatcher,
  options: WaitForRecordedOptions = {}
): Promise<void> {
  const { timeoutMs, intervalMs } = normalizeOptions(options)
  const deadline = Date.now() + timeoutMs

  do {
    await recorder.flush()
    const matches = await findEntries(recorder, matcher)

    if (matches.length > 0) {
      throw new Error(
        `Expected Periscope not to record an entry matching ${describeMatcher(matcher)}, ` +
          `but found ${matches.length}: ${describeEntries(matches)}.`
      )
    }

    if (Date.now() >= deadline) return
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())))
  } while (Date.now() <= deadline)
}

/** Remove recordings, optionally only for one application. */
export async function clearRecorded(recorder: Recorder, application?: string): Promise<void> {
  await recorder.mute(() => recorder.store.clear(application))
}

function matchesEntry(entry: StoredEntry, matcher: RecordedEntryMatcher): boolean {
  return (
    (matcher.type === undefined || entry.type === matcher.type) &&
    (matcher.application === undefined || entry.application === matcher.application) &&
    (matcher.batchId === undefined || entry.batchId === matcher.batchId) &&
    (matcher.tags === undefined || matcher.tags.every((tag) => entry.tags.includes(tag))) &&
    (matcher.predicate === undefined || matcher.predicate(entry))
  )
}
