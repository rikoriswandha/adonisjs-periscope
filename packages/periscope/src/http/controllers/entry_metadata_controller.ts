/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import type { PeriscopeStore, ResolvedPeriscopeConfig, StoredFlag } from '../../types.ts'

const ENTRY_METADATA_PREFIX = 'entry-meta:'
const MAX_NOTE_LENGTH = 2_000

type EntryMetadata = {
  uuid: string
  pinned: boolean
  note: string | null
  updatedAt: string | null
}

function parseMetadata(flag: StoredFlag): EntryMetadata | null {
  try {
    const value = JSON.parse(flag.value) as Record<string, unknown>
    const uuid = flag.name.slice(ENTRY_METADATA_PREFIX.length)

    if (uuid.length === 0) return null

    return {
      uuid,
      pinned: value.pinned === true,
      note: typeof value.note === 'string' ? value.note : null,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    }
  } catch {
    return null
  }
}

export class EntryMetadataController {
  constructor(
    private readonly store: PeriscopeStore,
    private readonly config: ResolvedPeriscopeConfig
  ) {}

  async index() {
    const flags = await this.store.flagsWithPrefix(ENTRY_METADATA_PREFIX)
    return {
      records: flags
        .map(parseMetadata)
        .filter((record): record is EntryMetadata => record !== null),
    }
  }

  async set({ params, request, response }: HttpContext) {
    const uuid = params.uuid
    if (typeof uuid !== 'string' || uuid.length === 0) {
      response.badRequest({ error: 'Entry UUID is required' })
      return
    }

    const note = request.input('note')
    if (typeof note === 'string' && note.length > MAX_NOTE_LENGTH) {
      response.badRequest({ error: `Note must not exceed ${MAX_NOTE_LENGTH} characters` })
      return
    }

    const name = `${ENTRY_METADATA_PREFIX}${uuid}`
    const currentValue = await this.store.getFlag(name)
    let current: EntryMetadata = { uuid, pinned: false, note: null, updatedAt: null }

    if (currentValue !== null) {
      current = parseMetadata({ name, value: currentValue }) ?? {
        uuid,
        pinned: false,
        note: null,
        updatedAt: null,
      }
    }

    const hasPinned = request.input('pinned') !== undefined
    const hasNote = note !== undefined
    const pinned = hasPinned ? request.input('pinned') === true : current.pinned
    const mergedNote = hasNote ? (typeof note === 'string' ? note : null) : current.note

    if (!hasPinned && !hasNote) return current

    if (!pinned && mergedNote === null) {
      await this.store.deleteFlag(name)
      return { uuid, pinned: false, note: null, updatedAt: null }
    }

    const updatedAt = new Date().toISOString()
    const retention = this.config.storage.retention
    const options = retention
      ? { expiresAt: new Date(Date.now() + retention.hours * 60 * 60 * 1_000) }
      : undefined

    await this.store.setFlag(name, JSON.stringify({ pinned, note: mergedNote, updatedAt }), options)
    return { uuid, pinned, note: mergedNote, updatedAt }
  }
}
