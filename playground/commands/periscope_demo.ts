import { setTimeout as sleep } from 'node:timers/promises'

import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import recorder from 'periscope/services/recorder'
import { BatchScope, EntryType, IncomingEntry } from 'periscope'

/**
 * The Phase 1 demo from the implementation plan:
 *
 * > "a script in playground records 3 fake entries in a scope, flushes to memory store, prints
 * >  the batch."
 *
 * It is the smallest end-to-end proof that the whole Phase 1 pipeline is wired: the provider
 * resolved `config/periscope.ts`, built the memory store and bound the recorder; `BatchScope`
 * correlates entries recorded across async boundaries into one batch; the recorder redacts,
 * tags, caps and stamps them; and the store reads them back in timeline order.
 *
 * Run it with `node ace periscope:demo`.
 */
export default class PeriscopeDemo extends BaseCommand {
  static commandName = 'periscope:demo'
  static description = 'Record a few fake entries through Periscope and print the resulting batch'

  /**
   * The recorder is a container singleton wired by the provider, so the demo needs a booted
   * application rather than a bare ace kernel.
   */
  static options: CommandOptions = { startApp: true }

  async run() {
    /**
     * Built by hand rather than through `BatchScope.run` because the demo needs the batch id
     * afterwards, to read the batch back out of the store.
     */
    const context = BatchScope.createContext('command')

    await BatchScope.runWith(context, async () => {
      recorder.record(
        IncomingEntry.make(EntryType.REQUEST, {
          method: 'POST',
          url: '/demo/login',
          status: 200,
          /**
           * Not redacted by the watcher — redacted by the recorder, before it ever reaches the
           * buffer. That is the point of printing it below.
           */
          payload: { email: 'demo@periscope.test', password: 'hunter2' },
        }).withTags('status:200')
      )

      /**
       * Recorded from inside a promise continuation, to show the AsyncLocalStorage batch context
       * surviving an async boundary rather than only working for straight-line code.
       */
      await Promise.resolve()

      recorder.record(
        IncomingEntry.make(EntryType.QUERY, {
          sql: 'select * from "users" where "email" = ?',
          bindings: ['demo@periscope.test'],
          duration: 3.2,
        }).withFamilyHash('demo-family-hash')
      )

      /**
       * And from a macrotask, which is where a naive ALS integration falls apart.
       */
      await sleep(1)

      recorder.record(IncomingEntry.make(EntryType.LOG, { level: 'warn', message: 'demo warning' }))
    })

    await recorder.flush(context)

    const entries = await recorder.store.batch(context.batchId)

    this.logger.info(`batch ${context.batchId} — ${entries.length} entries`)

    const table = this.ui.table()
    table.head(['#', 'type', 'tags', 'content'])

    entries.forEach((entry, index) => {
      table.row([
        String(index + 1),
        entry.type,
        entry.tags.join(', ') || '—',
        JSON.stringify(entry.content),
      ])
    })

    table.render()

    const request = entries.find((entry) => entry.type === EntryType.REQUEST)
    const payload = request?.content.payload as { password?: string } | undefined

    this.logger.info(`password recorded as: ${payload?.password}`)
  }
}
