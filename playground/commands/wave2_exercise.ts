import { args, BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class Wave2Exercise extends BaseCommand {
  static commandName = 'wave2:exercise'
  static description = 'Exercise the Periscope CommandWatcher with a playground-owned command'
  static options: CommandOptions = { startApp: true }

  @args.string()
  declare scenario: string

  @flags.string()
  declare password?: string

  async run() {
    this.logger.info(`Wave 2 command completed for ${this.scenario}`)
  }
}
