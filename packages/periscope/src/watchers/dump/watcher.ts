/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { clearInterval, setInterval } from 'node:timers'

import { IncomingEntry } from '../../entry.ts'
import { BatchScope } from '../../recorder/context.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard, safeguardAsync } from '../../safeguard.ts'
import { EntryType, Flag, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import { getActiveWatcher, setActiveWatcher } from '../active.ts'
import type { WatcherContext } from '../context.ts'
import type { DumpCaller, DumpEntryContent } from './types.ts'

/**
 * The dashboard renews the flag every 30 seconds. Polling once a second keeps `dump()` synchronous
 * while bounding both activation latency and idle store traffic.
 */
const DUMP_FLAG_POLL_MS = 1_000

/**
 * Bridges the asynchronous `dump-open` store flag to the synchronous exported `dump()` helper.
 */
export class DumpWatcher implements Watcher {
  readonly name = WatcherName.DUMP

  readonly #context: WatcherContext
  #active = false
  #registered = false
  #generation = 0
  #timer: NodeJS.Timeout | null = null
  #refreshing: Promise<void> | null = null

  constructor(context: WatcherContext) {
    this.#context = context
  }

  /**
   * Read the cached flag state without performing I/O.
   */
  get active(): boolean {
    return this.#active
  }

  /**
   * Record application values synchronously. The flag check is repeated here so every caller of
   * this public seam gets the same gate, not only the shipped `dump()` helper.
   */
  record(values: readonly unknown[], caller?: DumpCaller): void {
    if (!this.#active || !this.#registered) {
      return
    }

    safeguard('periscope.dump.record', () => {
      const content: DumpEntryContent = {
        values: safeSerialize(values),
        ...(caller === undefined ? {} : { caller }),
      }

      this.#context.recorder.record(IncomingEntry.make(EntryType.DUMP, content))
    })
  }

  /**
   * Coalesce slow flag reads so an interval can never pile up concurrent store operations.
   */
  #refresh(): Promise<void> {
    if (this.#refreshing !== null) {
      return this.#refreshing
    }

    const generation = this.#generation
    const refresh = safeguardAsync('periscope.dump.refresh', async () => {
      let active = false

      try {
        active = await BatchScope.mute(async () => {
          const leased = await this.#context.recorder.store.hasFlagWithPrefix(`${Flag.DUMP_OPEN}:`)
          return leased || (await this.#context.recorder.store.getFlag(Flag.DUMP_OPEN)) !== null
        })
      } finally {
        if (this.#registered && this.#generation === generation) {
          this.#active = active
        }
      }
    })

    this.#refreshing = refresh
    void refresh.then(() => {
      if (this.#refreshing === refresh) {
        this.#refreshing = null
      }
    })

    return refresh
  }

  async register(): Promise<void> {
    if (this.#registered) {
      return
    }

    this.#registered = true
    const generation = ++this.#generation

    /** Seed the synchronous state before publishing the watcher to `dump()`. */
    await this.#refresh()

    if (!this.#registered || this.#generation !== generation) {
      return
    }

    setActiveWatcher('dump', this)
    this.#timer = setInterval(() => {
      void this.#refresh()
    }, DUMP_FLAG_POLL_MS)
    this.#timer.unref()
  }

  cleanup(): void {
    this.#registered = false
    this.#generation++
    this.#active = false
    this.#refreshing = null

    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }

    if (getActiveWatcher('dump') === this) {
      setActiveWatcher('dump', null)
    }
  }
}
