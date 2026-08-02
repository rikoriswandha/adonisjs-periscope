/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { readFile } from 'node:fs/promises'

import { BaseCommand, flags } from '@adonisjs/core/ace'

import { parseBatchExport } from '../src/batch_export.ts'
import { Recorder } from '../src/recorder/recorder.ts'
import { nextSequence } from '../src/recorder/sequence.ts'
import { ensureDurableStorage } from './_ensure_durable_storage.ts'

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8')

  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
  }

  return input
}

/**
 * Import one portable Periscope batch into the configured durable store.
 */
export default class PeriscopeImport extends BaseCommand {
  static commandName = 'periscope:import'
  static description = 'Import a Periscope batch export'
  static options = { startApp: true }

  @flags.string({
    required: true,
    description: 'Batch export file to import, or - to read from stdin',
  })
  declare file: string

  @flags.string({
    description: 'Override the application on every imported entry',
  })
  declare application?: string

  async run() {
    ensureDurableStorage(this.app)

    const json = this.file === '-' ? await readStdin() : await readFile(this.file, 'utf8')
    const batch = parseBatchExport(json)
    const application = this.application ?? batch.application

    const recorder = await this.app.container.make(Recorder)

    /**
     * The SQL stores ignore an insert whose uuid already exists, so importing a batch twice
     * would otherwise "succeed" without writing anything. Pre-checking each uuid keeps the
     * summary honest and makes a full re-import an explicit error instead of a silent no-op.
     */
    const existing = new Set<string>()
    await recorder.mute(async () => {
      for (const entry of batch.entries) {
        if ((await recorder.store.find(entry.uuid)) !== null) {
          existing.add(entry.uuid)
        }
      }
    })

    const entries = batch.entries
      .filter((entry) => !existing.has(entry.uuid))
      .map((entry) => ({
        ...entry,
        application,
        sequence: nextSequence(),
      }))

    if (entries.length === 0) {
      throw new Error(
        `Batch "${batch.batchId}" is already imported: all ${batch.entries.length} entries exist in the store.`
      )
    }

    await recorder.mute(() => recorder.store.save(entries))

    const skipped = existing.size > 0 ? ` Skipped ${existing.size} already-present entries.` : ''
    this.logger.success(
      `Imported ${entries.length} entries from batch "${batch.batchId}" into application "${application}".${skipped}`
    )
  }
}
