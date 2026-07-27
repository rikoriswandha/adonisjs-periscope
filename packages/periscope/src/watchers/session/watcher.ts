import { createHash } from 'node:crypto'

import { IncomingEntry } from '../../entry.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { SessionEntryContent, SessionOperation } from './types.ts'

type SessionLike = {
  sessionId: string
  fresh: boolean
  readonly: boolean
  hasBeenModified: boolean
  all(): unknown
}

type SessionEvents = {
  'session:initiated': { session: SessionLike }
  'session:committed': { session: SessionLike }
  'session:migrated': {
    fromSessionId: string
    toSessionId: string
    session: SessionLike
  }
}

type SessionEventSource = {
  on<Event extends keyof SessionEvents>(
    event: Event,
    listener: (payload: SessionEvents[Event]) => void
  ): () => void
}

function hashSessionId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

/** Records official @adonisjs/session lifecycle events while never retaining raw session IDs. */
export class SessionWatcher implements Watcher {
  readonly name = WatcherName.SESSION
  readonly stats = { recorded: 0 }

  readonly #context: WatcherContext
  readonly #unsubscribers: (() => void)[] = []

  constructor(context: WatcherContext) {
    this.#context = context
  }

  register(): void {
    if (this.#unsubscribers.length > 0) return
    const emitter = this.#context.emitter as unknown as SessionEventSource

    this.#unsubscribers.push(
      emitter.on('session:initiated', (payload) => {
        safeguard('periscope.watcher.session.initiated', () =>
          this.#record('initiated', payload.session)
        )
      }),
      emitter.on('session:committed', (payload) => {
        safeguard('periscope.watcher.session.committed', () =>
          this.#record('committed', payload.session)
        )
      }),
      emitter.on('session:migrated', (payload) => {
        safeguard('periscope.watcher.session.migrated', () =>
          this.#record('migrated', payload.session, payload.fromSessionId)
        )
      })
    )
  }

  cleanup(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      safeguard('periscope.watcher.session.cleanup', unsubscribe)
    }
  }

  #record(operation: SessionOperation, session: SessionLike, fromSessionId?: string): void {
    const sessionIdHash = hashSessionId(session.sessionId)
    const content: SessionEntryContent = {
      operation,
      sessionIdHash,
      ...(fromSessionId === undefined ? {} : { fromSessionIdHash: hashSessionId(fromSessionId) }),
      fresh: session.fresh,
      readonly: session.readonly,
      modified: session.hasBeenModified,
      ...(this.#context.config.watchers.session.captureValues
        ? { values: safeSerialize(session.all()) }
        : {}),
    }

    this.#context.recorder.record(
      IncomingEntry.make(EntryType.SESSION, content).withTags(
        `session:${sessionIdHash}`,
        `operation:${operation}`
      )
    )
    this.stats.recorded += 1
  }
}
