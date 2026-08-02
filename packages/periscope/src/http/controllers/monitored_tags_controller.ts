/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import { TAG_INDEX_MAX_LENGTH } from '../../storage/sql.ts'
import type { PeriscopeStore } from '../../types.ts'
import { firstQueryString } from '../query.ts'

function tagFrom(context: HttpContext): string | null {
  const tag = context.params.tag

  if (typeof tag !== 'string' || tag.length === 0 || tag.length > TAG_INDEX_MAX_LENGTH) {
    context.response.badRequest({
      error: `Tag must contain between 1 and ${TAG_INDEX_MAX_LENGTH} characters`,
    })
    return null
  }

  return tag
}

export class MonitoredTagsController {
  constructor(
    private readonly store: PeriscopeStore,
    private readonly applicationName: string = 'default'
  ) {}

  async index(context?: HttpContext) {
    const application =
      (context && firstQueryString(context.request.qs().application)) ?? this.applicationName
    const tags = await this.store.monitoredTags(application)
    return { data: tags.sort((left, right) => left.localeCompare(right)) }
  }

  async set(context: HttpContext): Promise<void> {
    const tag = tagFrom(context)
    if (tag === null) return

    const application = firstQueryString(context.request.qs().application) ?? this.applicationName
    await this.store.monitorTag(tag, application)
    context.response.noContent()
  }

  async delete(context: HttpContext): Promise<void> {
    const tag = tagFrom(context)
    if (tag === null) return

    const application = firstQueryString(context.request.qs().application) ?? this.applicationName
    await this.store.unmonitorTag(tag, application)
    context.response.noContent()
  }
}
