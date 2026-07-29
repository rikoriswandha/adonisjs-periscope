/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import { serializeBatchExport } from '../../batch_export.ts'
import { EntryType } from '../../types.ts'
import type { EntryQuery, PeriscopeStore } from '../../types.ts'
import { firstQueryString } from '../query.ts'
import { serializeEntry, serializeEntryPage } from '../serialize.ts'

const MAX_EML_FILENAME_STEM_LENGTH = 120
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Keep only unambiguous, real ISO datetimes. Invalid filters are omitted rather than turning a
 * dashboard typo into an API error or an empty result set.
 */
function validIsoDateTime(value: string | undefined): string | undefined {
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
 * Keep the download name portable and, more importantly, incapable of escaping the quoted
 * Content-Disposition parameter. The original subject remains available in the entry payload.
 */
function emlFilename(subject: unknown, uuid: string): string {
  let stem = typeof subject === 'string' ? subject.normalize('NFKD') : ''
  stem = stem
    .replace(/[^\x20-\x7e]/g, '-')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()

  if (stem.toLowerCase().endsWith('.eml')) {
    stem = stem.slice(0, -4)
  }

  stem = stem
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, MAX_EML_FILENAME_STEM_LENGTH)
    .replace(/[.\s-]+$/g, '')

  if (stem.length === 0) {
    const safeUuid = uuid.replace(/[^a-z0-9_-]/gi, '').slice(0, 64)
    stem = `message-${safeUuid || 'download'}`
  }

  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) {
    stem = `message-${stem}`
  }

  return `${stem}.eml`
}

function emlBody(content: Record<string, unknown>): string | Buffer | undefined {
  const raw = content.raw
  if (typeof raw !== 'string') {
    return undefined
  }

  if (content.rawEncoding === undefined) {
    return /\S/u.test(raw) ? raw : undefined
  }

  if (content.rawEncoding !== 'base64' || raw.length === 0) {
    return undefined
  }

  const decoded = Buffer.from(raw, 'base64')
  return decoded.byteLength === 0 ? undefined : decoded
}

export class EntriesController {
  constructor(private readonly store: PeriscopeStore) {}

  async index({ request }: HttpContext) {
    const qs = request.qs()
    const type = firstQueryString(qs.type)
    const rawTags = qs.tag
    const tags =
      typeof rawTags === 'string'
        ? [rawTags]
        : Array.isArray(rawTags)
          ? rawTags.filter((tag): tag is string => typeof tag === 'string')
          : []
    const text = firstQueryString(qs.text)
    const from = validIsoDateTime(firstQueryString(qs.from))
    const to = validIsoDateTime(firstQueryString(qs.to))
    const familyHash = firstQueryString(qs.family_hash)
    const batchId = firstQueryString(qs.batch_id)
    const application = firstQueryString(qs.application)
    const cursor = firstQueryString(qs.cursor)
    const rawLimit = firstQueryString(qs.limit)
    const rawDisplayOnIndex = firstQueryString(qs.display_on_index)
    const query: EntryQuery = {}

    if (type !== undefined) query.type = type as EntryType
    if (tags.length === 1) query.tag = tags[0]
    if (tags.length > 1) query.tags = tags
    if (text !== undefined) query.text = text
    if (from !== undefined) query.from = from
    if (to !== undefined) query.to = to
    if (familyHash !== undefined) query.familyHash = familyHash
    if (batchId !== undefined) query.batchId = batchId
    if (application !== undefined) query.application = application
    if (cursor !== undefined) query.cursor = cursor
    if (rawLimit !== undefined) query.limit = Number(rawLimit)

    if (rawDisplayOnIndex === 'true' || rawDisplayOnIndex === '1') {
      query.displayOnIndex = true
    } else if (rawDisplayOnIndex === 'false' || rawDisplayOnIndex === '0') {
      query.displayOnIndex = false
    }

    return serializeEntryPage(await this.store.list(query))
  }

  async show({ params, response }: HttpContext) {
    const entry = await this.store.find(params.uuid)

    if (entry === null) {
      response.notFound()
      return
    }

    return { data: serializeEntry(entry) }
  }

  async eml({ params, response }: HttpContext) {
    const entry = await this.store.find(params.uuid)
    const body = entry === null ? undefined : emlBody(entry.content)

    if (entry === null || entry.type !== EntryType.MAIL || body === undefined) {
      response.notFound()
      return
    }

    response.header('Content-Type', 'message/rfc822')
    response.header(
      'Content-Disposition',
      `attachment; filename="${emlFilename(entry.content.subject, entry.uuid)}"`
    )
    response.send(body, false)
  }

  async batch({ params }: HttpContext) {
    const entries = await this.store.batch(params.batchId)

    return { data: entries.map(serializeEntry) }
  }

  async exportBatch({ params, response }: HttpContext) {
    const entries = await this.store.batch(params.batchId)
    if (entries.length === 0) {
      response.notFound()
      return
    }

    const safeBatchId = String(params.batchId)
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(0, 128)
    response.header('Content-Type', 'application/json; charset=utf-8')
    response.header(
      'Content-Disposition',
      `attachment; filename="periscope-batch-${safeBatchId || 'export'}.json"`
    )
    response.send(serializeBatchExport(params.batchId, entries), false)
  }
}
