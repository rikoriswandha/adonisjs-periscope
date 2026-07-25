/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { randomUUID } from 'node:crypto'

import { PeriscopeError } from './errors.ts'
import type { EntryContent, EntryType, StoredEntry } from './types.ts'

/**
 * An entry on its way into the recorder.
 *
 * Watchers build one of these and hand it to `recorder.record()`. It is deliberately mutable
 * and fluent: a watcher describes what it saw, the recorder's pipeline then scrubs the content,
 * appends hook tags, and finally stamps the batch id and sequence that turn it into a
 * {@link StoredEntry}.
 *
 * ```ts
 * recorder.record(
 *   IncomingEntry.make(EntryType.QUERY, { sql, bindings, duration })
 *     .withTags(`connection:${connection}`)
 *     .withFamilyHash(familyHash)
 * )
 * ```
 */
export class IncomingEntry {
  /**
   * Stable identity, generated up front so a watcher can reference an entry it has not yet
   * handed over (the http-client watcher builds an entry at request-create and finishes it at
   * response-trailers).
   */
  readonly uuid: string

  readonly type: EntryType

  /**
   * When the watcher observed the thing being recorded. Millisecond resolution; ordering uses
   * {@link IncomingEntry.sequence} instead.
   */
  readonly createdAt: Date

  /**
   * The payload. Mutable because the recorder replaces it with a redacted copy.
   */
  content: EntryContent

  /**
   * Groups entries the dashboard should treat as the same thing: the same normalised SQL, the
   * same exception at the same call site.
   */
  familyHash: string | null = null

  /**
   * Whether the entry shows up on its type's index screen. Sub-entries that only make sense
   * inside a batch timeline set this to `false` via {@link IncomingEntry.hiddenFromIndex}.
   */
  displayOnIndex: boolean = true

  /**
   * Correlation id, stamped by the recorder from the active batch.
   */
  batchId: string | null = null

  /**
   * Monotonic ordering stamp, assigned by the recorder at record time.
   */
  sequence: bigint | null = null

  /**
   * Backing store for tags. A `Set` because tags come from three places — the watcher, the
   * recorder's automatic tags and the configured tag hooks — and duplicates are meaningless.
   */
  readonly #tags = new Set<string>()

  private constructor(type: EntryType, content: EntryContent) {
    this.uuid = randomUUID()
    this.type = type
    this.content = content
    this.createdAt = new Date()
  }

  /**
   * The entry's tags, in insertion order.
   */
  get tags(): string[] {
    return [...this.#tags]
  }

  /**
   * Create an entry of `type` carrying `content`.
   */
  static make(type: EntryType, content: EntryContent = {}): IncomingEntry {
    return new IncomingEntry(type, content)
  }

  /**
   * Attach tags. Empty and duplicate tags are ignored, so callers can pass conditionally-built
   * lists without filtering first.
   */
  withTags(...tags: (string | undefined | null)[]): this {
    for (const tag of tags) {
      if (typeof tag === 'string' && tag.length > 0) {
        this.#tags.add(tag)
      }
    }

    return this
  }

  /**
   * Set the grouping hash. Passing an empty value clears it.
   */
  withFamilyHash(familyHash: string | null): this {
    this.familyHash = familyHash === '' ? null : familyHash
    return this
  }

  /**
   * Keep the entry out of index screens. It stays visible inside its batch's timeline.
   */
  hiddenFromIndex(): this {
    this.displayOnIndex = false
    return this
  }

  /**
   * Bind the entry to a batch and give it its ordering stamp. Called once, by the recorder.
   */
  stamp(batchId: string, sequence: bigint): this {
    this.batchId = batchId
    this.sequence = sequence
    return this
  }

  /**
   * Freeze the entry into the shape storage drivers persist.
   *
   * Throws when the entry was never stamped — that would mean an entry escaped the recorder,
   * which is a bug in Periscope rather than in the host application.
   */
  toStored(): StoredEntry {
    if (this.batchId === null || this.sequence === null) {
      throw new PeriscopeError(
        `Entry ${this.uuid} (${this.type}) was never stamped with a batch id and sequence. ` +
          'Entries must reach storage through recorder.record().'
      )
    }

    return {
      uuid: this.uuid,
      batchId: this.batchId,
      type: this.type,
      familyHash: this.familyHash,
      content: this.content,
      tags: this.tags,
      shouldDisplayOnIndex: this.displayOnIndex,
      sequence: this.sequence,
      createdAt: this.createdAt,
    }
  }
}
