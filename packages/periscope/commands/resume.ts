/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { BaseCommand } from '@adonisjs/core/ace'

import { Recorder } from '../src/recorder/recorder.ts'
import { Flag } from '../src/types.ts'
import { ensureDurableStorage } from './_ensure_durable_storage.ts'

/**
 * Resume recording by removing the shared store flag.
 */
export default class PeriscopeResume extends BaseCommand {
  static commandName = 'periscope:resume'
  static description = 'Resume Periscope recording'
  static options = { startApp: true }

  async run() {
    ensureDurableStorage(this.app)

    const recorder = await this.app.container.make(Recorder)

    await recorder.mute(() => recorder.store.deleteFlag(Flag.PAUSED))

    this.logger.success('Resumed Periscope recording')
  }
}
