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
 * Delete every recorded entry while preserving Periscope state.
 */
export default class PeriscopeClear extends BaseCommand {
  static commandName = 'periscope:clear'
  static description = 'Delete all Periscope entries'
  static options = { startApp: true }

  @flags.string({
    description: 'Clear entries recorded by one application only',
  })
  declare application?: string

  async run() {
    ensureDurableStorage(this.app)

    const recorder = await this.app.container.make(Recorder)

    await recorder.mute(() => recorder.store.clear(this.application))

    if (this.application === undefined) {
      this.logger.success('Cleared all Periscope entries')
    } else {
      this.logger.success(`Cleared Periscope entries for application "${this.application}"`)
    }
  }
}
