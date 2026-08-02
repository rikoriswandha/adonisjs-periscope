/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { IncomingEntry } from '../../entry.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { I18nEntryContent } from './types.ts'

type MissingTranslationEvent = {
  locale: unknown
  identifier: unknown
  hasFallback?: unknown
}

type I18nEventSource = {
  on(
    event: 'i18n:missing:translation',
    listener: (event: MissingTranslationEvent) => void
  ): () => void
}

function readField(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== 'object') return undefined

  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}

/** Records translations missing from the requested locale. */
export class I18nWatcher implements Watcher {
  readonly name = WatcherName.I18N
  readonly stats = { recorded: 0, ignored: 0 }

  readonly #context: WatcherContext
  #unsubscribe: (() => void) | null = null

  constructor(context: WatcherContext) {
    this.#context = context
  }

  readonly #handler = (event: MissingTranslationEvent): void => {
    safeguard('periscope.watcher.i18n.record', () => {
      const locale = readField(event, 'locale')
      const identifier = readField(event, 'identifier')
      const hasFallback = readField(event, 'hasFallback')

      if (typeof locale !== 'string' || typeof identifier !== 'string') {
        this.stats.ignored++
        return
      }

      const content: I18nEntryContent = {
        locale,
        identifier,
        ...(typeof hasFallback === 'boolean' ? { hasFallback } : {}),
      }
      const entry = IncomingEntry.make(EntryType.I18N, content).withTags(
        `locale:${locale}`,
        'missing-translation'
      )

      this.#context.recorder.record(entry)
      this.stats.recorded++
    })
  }

  register(): void {
    if (!this.#context.config.watchers.i18n.enabled || this.#unsubscribe !== null) return

    const source = this.#context.emitter as unknown as I18nEventSource
    const unsubscribe = safeguard('periscope.watcher.i18n.subscribe', () =>
      source.on('i18n:missing:translation', this.#handler)
    )
    if (typeof unsubscribe === 'function') this.#unsubscribe = unsubscribe
  }

  cleanup(): void {
    const unsubscribe = this.#unsubscribe
    this.#unsubscribe = null
    if (unsubscribe !== null) {
      safeguard('periscope.watcher.i18n.unsubscribe', unsubscribe)
    }
  }
}
