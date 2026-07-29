/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { BaseCommand, flags } from '@adonisjs/core/ace'

import { Recorder } from '../src/recorder/recorder.ts'
import { ensureDurableStorage } from './_ensure_durable_storage.ts'

/**
 * Delete entries older than the configured retention window.
 */
export default class PeriscopePrune extends BaseCommand {
  static commandName = 'periscope:prune'
  static description = 'Delete old Periscope entries'
  static options = { startApp: true }

  @flags.number({
    default: 48,
    description: 'Delete entries older than this many hours',
  })
  declare hours: number

  @flags.boolean({
    default: false,
    description: 'Keep exception entries regardless of age',
  })
  declare keepExceptions: boolean

  @flags.string({
    description: 'Prune entries recorded by one application only',
  })
  declare application?: string

  async run() {
    ensureDurableStorage(this.app)

    if (!Number.isFinite(this.hours) || this.hours <= 0) {
      throw new Error('The --hours flag must be a finite number greater than 0.')
    }

    const recorder = await this.app.container.make(Recorder)
    const before = new Date(Date.now() - this.hours * 60 * 60 * 1_000)
    const deleted = await recorder.mute(() =>
      recorder.store.prune({
        before,
        keepExceptions: this.keepExceptions,
        application: this.application,
      })
    )

    this.logger.success(`Pruned ${deleted} Periscope ${deleted === 1 ? 'entry' : 'entries'}`)
  }
}
