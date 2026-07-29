/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { writeFile } from 'node:fs/promises'

import { BaseCommand, flags } from '@adonisjs/core/ace'

import { serializeBatchExport } from '../src/batch_export.ts'
import { Recorder } from '../src/recorder/recorder.ts'
import { ensureDurableStorage } from './_ensure_durable_storage.ts'

/**
 * Export one recorded batch in Periscope's portable JSON format.
 */
export default class PeriscopeExport extends BaseCommand {
  static commandName = 'periscope:export'
  static description = 'Export a Periscope batch as JSON'
  static options = { startApp: true }

  @flags.string({
    required: true,
    description: 'Batch identifier to export',
  })
  declare batch: string

  @flags.string({
    description: 'Write the export to this file instead of stdout',
  })
  declare out?: string

  async run() {
    ensureDurableStorage(this.app)

    const recorder = await this.app.container.make(Recorder)
    const entries = await recorder.mute(() => recorder.store.batch(this.batch))
    const json = serializeBatchExport(this.batch, entries)

    if (json === null) {
      throw new Error(`No Periscope entries found for batch "${this.batch}".`)
    }

    if (this.out !== undefined) {
      await writeFile(this.out, json, 'utf8')
      return
    }

    this.logger.log(json)
  }
}
