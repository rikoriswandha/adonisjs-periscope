/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import type { ExceptionGroupState, ExceptionGroupQuery, PeriscopeStore } from '../../types.ts'
import { firstQueryString } from '../query.ts'
import { serializeExceptionGroupPage } from '../serialize.ts'

const EXCEPTION_STATE_PREFIX = 'exception-state:'

type StoredExceptionState = {
  state: Exclude<ExceptionGroupState, 'open'>
  updatedAt: string
}

function parseStoredState(value: string): StoredExceptionState | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (
      (parsed.state !== 'resolved' && parsed.state !== 'ignored') ||
      typeof parsed.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.updatedAt))
    ) {
      return null
    }
    return { state: parsed.state, updatedAt: parsed.updatedAt }
  } catch {
    return null
  }
}

export class ExceptionGroupsController {
  constructor(
    private readonly store: PeriscopeStore,
    private readonly applicationName: string = 'default'
  ) {}

  async index({ request }: HttpContext) {
    const qs = request.qs()
    const cursor = firstQueryString(qs.cursor)
    const rawLimit = firstQueryString(qs.limit)
    const tag = firstQueryString(qs.tag)
    const application = firstQueryString(qs.application) ?? this.applicationName
    const query: ExceptionGroupQuery = { application }

    if (tag !== undefined) query.tag = tag
    if (cursor !== undefined) query.cursor = cursor
    if (rawLimit !== undefined) query.limit = Number(rawLimit)

    const page = await this.store.exceptionGroups(query)
    const prefix = `${EXCEPTION_STATE_PREFIX}${application}:`
    const flags = await this.store.flagsWithPrefix(prefix)
    const storedStates = new Map(
      flags
        .map((flag) => [flag.name.slice(prefix.length), parseStoredState(flag.value)] as const)
        .filter((entry): entry is readonly [string, StoredExceptionState] => entry[1] !== null)
    )
    const states = new Map<string, { state: ExceptionGroupState; stateUpdatedAt: string | null }>()

    for (const group of page.data) {
      const stored = storedStates.get(group.familyHash)
      if (stored === undefined) continue

      /**
       * Resolution describes the last observed occurrence. A newer exception makes the group
       * actionable again without requiring every recorder write path to mutate dashboard state.
       */
      if (stored.state === 'resolved' && Date.parse(stored.updatedAt) < group.lastSeen.getTime()) {
        continue
      }
      states.set(group.familyHash, { state: stored.state, stateUpdatedAt: stored.updatedAt })
    }

    return serializeExceptionGroupPage(page, states)
  }

  async setState({ params, request, response }: HttpContext) {
    const familyHash = params.familyHash
    const state = request.input('state')
    if (
      typeof familyHash !== 'string' ||
      (state !== 'open' && state !== 'resolved' && state !== 'ignored')
    ) {
      response.badRequest({ error: 'State must be open, resolved, or ignored' })
      return
    }

    const requestedApplication = request.input('application')
    const application =
      typeof requestedApplication === 'string' ? requestedApplication : this.applicationName
    const name = `${EXCEPTION_STATE_PREFIX}${application}:${familyHash}`

    if (state === 'open') {
      await this.store.deleteFlag(name)
      return { familyHash, state, stateUpdatedAt: null }
    }

    const updatedAt = new Date().toISOString()
    await this.store.setFlag(name, JSON.stringify({ state, updatedAt }))
    return { familyHash, state, stateUpdatedAt: updatedAt }
  }
}
