/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import type { ExceptionGroupQuery, PeriscopeStore } from '../../types.ts'
import { firstQueryString } from '../query.ts'
import { serializeExceptionGroupPage } from '../serialize.ts'

export class ExceptionGroupsController {
  constructor(private readonly store: PeriscopeStore) {}

  async index({ request }: HttpContext) {
    const qs = request.qs()
    const cursor = firstQueryString(qs.cursor)
    const rawLimit = firstQueryString(qs.limit)
    const tag = firstQueryString(qs.tag)
    const query: ExceptionGroupQuery = {}

    if (tag !== undefined) query.tag = tag
    if (cursor !== undefined) query.cursor = cursor
    if (rawLimit !== undefined) query.limit = Number(rawLimit)

    return serializeExceptionGroupPage(await this.store.exceptionGroups(query))
  }
}
