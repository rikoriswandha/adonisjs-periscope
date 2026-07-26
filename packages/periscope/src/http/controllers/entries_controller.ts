/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import type { EntryQuery, EntryType, PeriscopeStore } from '../../types.ts'
import { firstQueryString } from '../query.ts'
import { serializeEntry, serializeEntryPage } from '../serialize.ts'

export class EntriesController {
  constructor(private readonly store: PeriscopeStore) {}

  async index({ request }: HttpContext) {
    const qs = request.qs()
    const type = firstQueryString(qs.type)
    const tag = firstQueryString(qs.tag)
    const familyHash = firstQueryString(qs.family_hash)
    const batchId = firstQueryString(qs.batch_id)
    const cursor = firstQueryString(qs.cursor)
    const rawLimit = firstQueryString(qs.limit)
    const rawDisplayOnIndex = firstQueryString(qs.display_on_index)
    const query: EntryQuery = {}

    if (type !== undefined) query.type = type as EntryType
    if (tag !== undefined) query.tag = tag
    if (familyHash !== undefined) query.familyHash = familyHash
    if (batchId !== undefined) query.batchId = batchId
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

  async batch({ params }: HttpContext) {
    const entries = await this.store.batch(params.batchId)

    return { data: entries.map(serializeEntry) }
  }
}
