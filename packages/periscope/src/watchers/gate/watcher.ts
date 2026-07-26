/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { IncomingEntry } from '../../entry.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { GateEntryContent } from './types.ts'

/**
 * The Bouncer event payload this watcher consumes. Keeping the contract structural lets Bouncer
 * remain an optional peer while still checking every field used by the watcher.
 */
type AuthorizationFinishedEvent = {
  user: unknown
  action: string
  parameters: unknown[]
  response: {
    authorized: boolean
    status?: number
    message?: string
  }
}

type GateEventSource = {
  on(
    event: 'authorization:finished',
    listener: (event: AuthorizationFinishedEvent) => void
  ): () => void
}

/**
 * User models may expose `id` through a getter, so own-property checks are too restrictive. Read
 * that one conventional field defensively and retain only the JSON-safe scalar forms commonly
 * used for identifiers. Everything else remains available in the serialised `user` payload.
 */
function userId(user: unknown): string | number | undefined {
  if (user === null || typeof user !== 'object') {
    return undefined
  }

  try {
    const id = Reflect.get(user, 'id')

    if (typeof id === 'string') {
      return id
    }

    return typeof id === 'number' && Number.isFinite(id) ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Records the shared event emitted after Bouncer finishes an ability or policy authorization.
 */
export class GateWatcher implements Watcher {
  readonly name = WatcherName.GATE
  readonly stats = { recorded: 0, ignored: 0 }

  readonly #context: WatcherContext
  readonly #ignoredAbilities: Set<string>
  #unsubscribe: (() => void) | null = null

  constructor(context: WatcherContext) {
    this.#context = context
    this.#ignoredAbilities = new Set(context.config.watchers.gate.ignoreAbilities)
  }

  readonly #handler = (event: AuthorizationFinishedEvent): void => {
    safeguard('periscope.watcher.gate.record', () => {
      const ability = event.action

      if (this.#ignoredAbilities.has(ability)) {
        this.stats.ignored++
        return
      }

      const id = userId(event.user)
      const response = event.response
      const content: GateEntryContent = {
        ability,
        allowed: response.authorized,
        ...(id === undefined ? {} : { userId: id }),
        ...(event.user === null || event.user === undefined
          ? {}
          : { user: safeSerialize(event.user) }),
        args: safeSerialize(event.parameters),
        ...(response.status === undefined ? {} : { status: response.status }),
        ...(response.message === undefined ? {} : { message: response.message }),
      }

      const entry = IncomingEntry.make(EntryType.GATE, content).withTags(
        `ability:${ability}`,
        response.authorized ? 'allowed' : 'denied',
        id === undefined ? undefined : `user:${id}`,
        response.status === undefined ? undefined : `status:${response.status}`
      )

      this.#context.recorder.record(entry)
      this.stats.recorded++
    })
  }

  register(): void {
    if (this.#unsubscribe !== null) {
      return
    }

    const source = this.#context.emitter as unknown as GateEventSource
    const unsubscribe = safeguard('periscope.watcher.gate.subscribe', () =>
      source.on('authorization:finished', this.#handler)
    )

    if (unsubscribe !== undefined) {
      this.#unsubscribe = unsubscribe
    }
  }

  cleanup(): void {
    const unsubscribe = this.#unsubscribe
    this.#unsubscribe = null

    if (unsubscribe !== null) {
      safeguard('periscope.watcher.gate.unsubscribe', unsubscribe)
    }
  }
}
