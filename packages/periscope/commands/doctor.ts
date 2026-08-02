/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { fileURLToPath } from 'node:url'

import { BaseCommand, flags } from '@adonisjs/core/ace'

import { fixLucidDebugConfig, renderDoctorTable, runDoctorChecks } from '../src/hooks/doctor.ts'

/**
 * Diagnose a host application's Periscope installation.
 */
export default class PeriscopeDoctor extends BaseCommand {
  static commandName = 'periscope:doctor'
  static description = 'Check the Periscope installation and host application integration'
  static options = { startApp: true }

  @flags.boolean({
    default: false,
    description: 'Add missing debug: true settings to Lucid connection objects',
  })
  declare fix: boolean

  async run() {
    const appRoot = fileURLToPath(this.app.appRoot)
    if (this.fix) {
      const result = await fixLucidDebugConfig(appRoot)
      if (result.changed.length > 0) {
        this.logger.log(
          `Updated config/database.ts: added debug: true to ${result.changed.join(', ')}`
        )
      } else if (result.warning) {
        this.logger.log(`No changes written: ${result.warning}`)
      } else {
        this.logger.log('No changes needed: every Lucid connection already has a debug setting')
      }
    }

    const router = await this.app.container.make('router')
    const checks = await runDoctorChecks({ appRoot, routes: router.toJSON(), logger: this.logger })
    this.logger.log(renderDoctorTable(checks))

    const lucidDebug = checks.find((check) => check.name === 'Lucid debug')
    if (!this.fix && lucidDebug?.status === 'FAIL') {
      this.logger.log(
        'Suggested edit: add debug: true to each listed connection in config/database.ts, or rerun with --fix.'
      )
    }
    if (checks.some((check) => check.status === 'FAIL')) this.exitCode = 1
  }
}
