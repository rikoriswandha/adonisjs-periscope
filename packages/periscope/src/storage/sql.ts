/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The SQL storage schema, and the codecs that move a {@link StoredEntry} across it.
 *
 * Two drivers write these tables: `database` (P2.1, the application's own Lucid connection, so
 * postgres / mysql / sqlite) and `sqlite-local` (P2.2, a dedicated better-sqlite3 file). They
 * share this module so the two schemas cannot drift, and so a value round-trips to the same
 * JavaScript type whichever driver — and whichever dialect — read it back.
 *
 * Three column choices are deliberate and worth the paragraph they cost, because each one looks
 * wrong until you try the obvious alternative across all four dialects:
 *
 * - **`sequence` is a zero-padded 20-character string, not a `bigint`.** Sequences are
 *   nanosecond stamps around `1.8e18`, far past `Number.MAX_SAFE_INTEGER` (`9e15`). SQLite's
 *   64-bit `INTEGER` holds them, but knex hands them back as JavaScript `number`s, which silently
 *   rounds — and `sequence` is the sort key *and* the pagination cursor, so rounding it corrupts
 *   ordering and can make a cursor skip or repeat entries. Fixed-width decimal text sorts
 *   identically to the number it encodes, is exact in every dialect, and compares the same way in
 *   every collation (all locales order ASCII digits alike).
 *
 * - **`created_at` is epoch milliseconds in a `bigint` column, not a timestamp.** The contract
 *   asserts millisecond-exact round-trips. `datetime` is second-resolution in MySQL unless it is
 *   `datetime(3)`, knex serialises `Date` differently per dialect for SQLite, and timezone
 *   handling differs again. An integer is the same instant everywhere, and `created_at < ?` —
 *   the only comparison pruning does — works unchanged.
 *
 * - **`should_display_on_index` is a `0`/`1` integer, not a boolean.** better-sqlite3 refuses to
 *   bind a JavaScript boolean at all, while postgres refuses to accept `0` for a `boolean`
 *   column. An integer column is the one encoding both accept, which keeps {@link toEntryRow} a
 *   single dialect-free function instead of a per-driver branch.
 */

import { safeSerialize } from '../recorder/serializer.ts'
import type { EntryContent, EntryType, StoredEntry } from '../types.ts'

/**
 * Entries. One row per recorded entry; the primary key is the entry's uuid.
 */
export const ENTRIES_TABLE = 'periscope_entries'

/**
 * The tag lookup index — *an index, not the source of truth*. An entry's tags round-trip through
 * the `tags` JSON column of {@link ENTRIES_TABLE}, which is what preserves their order and lets
 * `find`, `list` and `batch` hydrate an entry without a join. These rows exist so that
 * `list({ tag })` is an index lookup rather than a scan over serialised JSON, and they are
 * written, deleted and cleared in the same transaction as the entries they describe.
 */
export const TAGS_TABLE = 'periscope_entry_tags'

/**
 * Tags the user asked to be monitored (P7.2). User intent, not recorded data — which is why
 * `clear()` leaves this table alone.
 */
export const MONITORED_TAGS_TABLE = 'periscope_monitored_tags'

/**
 * Flags: `paused`, `dump-open`. Also user intent, also spared by `clear()`.
 */
export const FLAGS_TABLE = 'periscope_flags'

/**
 * Width of the `sequence` text column. 20 digits covers every stamp until the year 5138, and
 * fixed width is what makes lexicographic comparison agree with numeric comparison.
 */
export const SEQUENCE_WIDTH = 20

/**
 * Maximum length of an indexed tag.
 *
 * 191 is MySQL's number, not ours: a `utf8mb4` index key is capped at 767 bytes on the older
 * InnoDB row formats, and 767 divided by the four bytes a `utf8mb4` character may take leaves
 * 191 characters. The other three dialects would allow more, but one shared width is what keeps
 * the four schemas identical.
 *
 * A longer tag is *skipped* by {@link toTagRows} rather than truncated. A truncated key is a key
 * no caller can ever produce, so `list({ tag })` would miss the very entry the row was written
 * for — a filter that lies. Skipping only ever costs a filter hit on a tag nobody could sensibly
 * filter by, and the entry's own `tags` column still carries the value in full. Storing it
 * untouched is not an option either: postgres rejects an over-length `varchar` outright, which
 * fails the insert and takes the entire batch of entries down with it.
 */
export const TAG_INDEX_MAX_LENGTH = 191

/**
 * Rows per `insert` statement. At nine columns per entry row, 200 rows binds 1 800 parameters:
 * well inside the postgres ceiling of 65 535, and inside SQLite's too, which has been 32 766
 * since 3.32 (better-sqlite3 12.x bundles 3.53). The only limit 1 800 would breach is SQLite's
 * pre-3.32 default of 999, which no build either driver can run on still uses. Chunking at all
 * is what turns a large batch into a handful of statements rather than hundreds of round trips.
 */
export const INSERT_CHUNK_SIZE = 200

/**
 * Written into `content` when a value cannot be serialised even after {@link safeSerialize} has
 * had a go at it. Storing a marker keeps the rest of the batch writable; dropping the batch
 * because one watcher handed us something exotic would lose the entries around it too.
 */
const UNSERIALIZABLE_CONTENT = '{"periscope:unserializable":true}'

/**
 * One row of {@link ENTRIES_TABLE}, in the shape both drivers bind and both dialects return.
 *
 * The write side is narrow — every value is a `string`, `number` or `null`, the intersection of
 * what knex and better-sqlite3 accept. The read side is wide, because dialects disagree about
 * what comes back: postgres parses `jsonb` into objects and returns `bigint` as a string, SQLite
 * returns text for both. {@link toStoredEntry} is where that disagreement ends.
 */
export type EntryRow = {
  uuid: string
  batch_id: string
  type: string
  family_hash: string | null
  content: unknown
  tags: unknown
  should_display_on_index: number | boolean
  sequence: string
  created_at: number | string | bigint
}

/**
 * One row of {@link TAGS_TABLE}.
 */
export type TagRow = {
  entry_uuid: string
  tag: string
}

/**
 * Encode a sequence for storage: fixed-width, zero-padded decimal.
 */
export function encodeSequence(sequence: bigint): string {
  return sequence.toString().padStart(SEQUENCE_WIDTH, '0')
}

/**
 * Decode a stored sequence. Leading zeros are legal input to `BigInt`, so the padding costs
 * nothing to undo.
 */
export function decodeSequence(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(String(value).trim())
}

/**
 * Encode a value as JSON text.
 *
 * `content` reaches storage having passed through the redactor, but not necessarily through
 * {@link safeSerialize} — watchers own their content shape, and one handing over a circular
 * object or a `BigInt` must not cost the batch its entries. So the fast path is a plain
 * `JSON.stringify`, and the fallbacks only run when it throws.
 */
export function encodeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    try {
      return JSON.stringify(safeSerialize(value)) ?? UNSERIALIZABLE_CONTENT
    } catch {
      return UNSERIALIZABLE_CONTENT
    }
  }
}

/**
 * Decode a JSON column. Postgres hands back an already-parsed `jsonb` value; SQLite hands back
 * the text. Unparseable text yields `undefined` rather than throwing: one corrupt row must not
 * break the page it appears on.
 */
export function decodeJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/**
 * Encode an entry as a row. See the module note for why booleans, timestamps and sequences all
 * arrive as numbers or strings.
 */
export function toEntryRow(entry: StoredEntry): EntryRow {
  return {
    uuid: entry.uuid,
    batch_id: entry.batchId,
    type: entry.type,
    family_hash: entry.familyHash,
    content: encodeJson(entry.content),
    tags: encodeJson(entry.tags),
    should_display_on_index: entry.shouldDisplayOnIndex ? 1 : 0,
    sequence: encodeSequence(entry.sequence),
    created_at: entry.createdAt.getTime(),
  }
}

/**
 * The tag index rows for an entry, de-duplicated: `(entry_uuid, tag)` is a primary key, and an
 * entry carrying the same tag twice must not fail its own insert.
 *
 * Tags longer than {@link TAG_INDEX_MAX_LENGTH} are left out of the index entirely — see that
 * constant for why skipping beats truncating. The entry loses nothing by it: its `tags` JSON
 * column is the authoritative, ordered, complete copy, and that is what the dashboard renders.
 * Only the filter index is thinner.
 */
export function toTagRows(entry: StoredEntry): TagRow[] {
  const seen = new Set<string>()
  const rows: TagRow[] = []

  for (const tag of entry.tags) {
    if (seen.has(tag) || tag.length > TAG_INDEX_MAX_LENGTH) {
      continue
    }

    seen.add(tag)
    rows.push({ entry_uuid: entry.uuid, tag })
  }

  return rows
}

/**
 * Hydrate a row back into a {@link StoredEntry}, normalising every dialect difference.
 *
 * Content and tags are defended rather than trusted: a `content` column that failed to parse
 * becomes an empty object and a `tags` column that did not decode into an array becomes an empty
 * array, so one unreadable row degrades to a thin entry instead of throwing inside a dashboard
 * request.
 */
export function toStoredEntry(row: EntryRow): StoredEntry {
  const content = decodeJson(row.content)
  const tags = decodeJson(row.tags)

  return {
    uuid: row.uuid,
    batchId: row.batch_id,
    type: row.type as EntryType,
    familyHash: row.family_hash === undefined ? null : row.family_hash,
    content:
      typeof content === 'object' && content !== null
        ? (content as EntryContent)
        : ({} as EntryContent),
    tags: Array.isArray(tags) ? (tags as string[]) : [],
    shouldDisplayOnIndex:
      row.should_display_on_index === true || Number(row.should_display_on_index) === 1,
    sequence: decodeSequence(row.sequence),
    createdAt: new Date(Number(row.created_at)),
  }
}
