/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import { TAG_INDEX_MAX_LENGTH } from '../../storage/sql.ts'
import type { PeriscopeStore } from '../../types.ts'

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
  constructor(private readonly store: PeriscopeStore) {}

  async index() {
    const tags = await this.store.monitoredTags()
    return { data: tags.sort((left, right) => left.localeCompare(right)) }
  }

  async set(context: HttpContext): Promise<void> {
    const tag = tagFrom(context)
    if (tag === null) return

    await this.store.monitorTag(tag)
    context.response.noContent()
  }

  async delete(context: HttpContext): Promise<void> {
    const tag = tagFrom(context)
    if (tag === null) return

    await this.store.unmonitorTag(tag)
    context.response.noContent()
  }
}
