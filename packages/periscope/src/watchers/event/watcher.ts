/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Records application events through the emitter's wildcard listener.
 *
 * Registering that listener has a process-wide, observable side effect. Emittery includes
 * wildcard listeners when answering `hasListeners(name)` for every name, so this watcher makes
 * `emitter.hasListeners('db:query')` and `emitter.hasListeners('http:request_completed')` true.
 * That is harmless-to-helpful here — both are watchers Periscope wants armed — but applications
 * which use those checks as feature gates will also observe the listener.
 */

import type { EmitterService } from '@adonisjs/core/types'

import { IncomingEntry } from '../../entry.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { EventEntryContent } from './types.ts'

const FRAMEWORK_EVENT =
  /^(http|db|session|mail|cache|authorization|queued?|container_binding|periscope):/
const MAX_PAYLOAD_BYTES = 8 * 1024

type EventIdentifier = string | symbol | number | Function

/**
 * Escape a literal fragment before placing it in a regular expression. Globs are split on `*`
 * first, which leaves every regular-expression metacharacter here as application data rather
 * than syntax.
 */
function escapeRegExp(fragment: string): string {
  return fragment.replace(/[\\^$.+?()[\]{}|]/g, '\\$&')
}

/**
 * Compile the deliberately small glob language once. Anchoring matters: `order:*` is a namespace
 * rule, not permission to hide an unrelated `preorder:*` event which merely contains it.
 */
function compileGlob(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`)
}

/**
 * Read the same fallback `data?.constructor?.name` the event contract describes, without trusting
 * an application object. A proxy may throw from either property access, and an anonymous
 * constructor contributes no usable display name.
 */
function payloadClassName(data: unknown): string | undefined {
  if (data === null || (typeof data !== 'object' && typeof data !== 'function')) {
    return undefined
  }

  try {
    if (!('constructor' in data)) {
      return undefined
    }

    const constructor = data.constructor
    if (typeof constructor !== 'function' || constructor.name.length === 0) {
      return undefined
    }

    return constructor.name
  } catch {
    return undefined
  }
}

/**
 * Prefer the emitter's resolved name and then the payload instance. Number keys and a theoretical
 * unresolved function are retained as final fallbacks so an allowed upstream event can never
 * become an unlabelled entry.
 */
function eventName(event: EventIdentifier, className: string | undefined): string {
  if (typeof event === 'string') {
    return event
  }

  if (typeof event === 'symbol' && event.description) {
    return event.description
  }

  if (className !== undefined) {
    return className
  }

  if (typeof event === 'function' && event.name.length > 0) {
    return event.name
  }

  return String(event)
}

/**
 * The public emitter type narrows names to the application's augmented event list, while `onAny`
 * exposes the transport's wider runtime key union. The cast only reconciles those two upstream
 * views. Emittery includes every wildcard listener in this number, so subtract this watcher's own
 * registration and leave other wildcard observers represented honestly.
 */
function countOtherListeners(emitter: EmitterService, event: EventIdentifier): number {
  const counter = emitter as unknown as {
    listenerCount(name: EventIdentifier): number
  }

  return Math.max(0, counter.listenerCount(event) - 1)
}

export class EventWatcher implements Watcher {
  readonly name = WatcherName.EVENT
  readonly stats = { recorded: 0, ignored: 0 }

  readonly #context: WatcherContext
  readonly #ignoredGlobs: RegExp[]
  #unsubscribe?: () => void

  constructor(context: WatcherContext) {
    this.#context = context
    this.#ignoredGlobs = context.config.watchers.event.ignore.map(compileGlob)
  }

  /**
   * Keep one stable function identity for the lifetime of the watcher. Besides making teardown
   * deterministic, this means a defensive second `register()` cannot add a second wildcard
   * observer to Emittery's Set-backed listener collection.
   */
  readonly #handler = (event: EventIdentifier, data: unknown): void => {
    safeguard('periscope.event.handle', () => {
      const className = payloadClassName(data)
      const name = eventName(event, className)

      if (FRAMEWORK_EVENT.test(name) || this.#ignoredGlobs.some((pattern) => pattern.test(name))) {
        this.stats.ignored++
        return
      }

      /**
       * AdonisJS resolves class constructors to `Symbol(ClassName)` before wildcard listeners
       * run. Requiring the description to agree with the payload instance avoids labelling an
       * application-owned symbol event as a class by accident.
       */
      const classEvent =
        typeof event === 'symbol' && className !== undefined && event.description === className
      const content: EventEntryContent = {
        name,
        payload: safeSerialize(data, { maxBytes: MAX_PAYLOAD_BYTES }),
        isClassEvent: classEvent,
        listenerCount: countOtherListeners(this.#context.emitter, event),
      }

      if (classEvent) {
        content.className = className
      }

      const entry = IncomingEntry.make(EntryType.EVENT, content).withTags(`event:${name}`)
      if (classEvent) {
        entry.withTags('class')
      }

      this.#context.recorder.record(entry)
      this.stats.recorded++
    })
  }

  register(): void {
    if (this.#unsubscribe !== undefined) {
      return
    }

    this.#unsubscribe = this.#context.emitter.onAny(this.#handler)
  }

  cleanup(): void {
    const unsubscribe = this.#unsubscribe
    this.#unsubscribe = undefined
    unsubscribe?.()
  }
}
