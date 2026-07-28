import { args, BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

export default class Wave2Exercise extends BaseCommand {
  static commandName = 'playground:exercise'
  static description = 'Exercise the Periscope CommandWatcher with a playground-owned command'
  static options: CommandOptions = { startApp: true }

  @args.string()
  declare scenario: string

  @flags.string()
  declare password?: string

  async run() {
    this.logger.info(`Watcher command completed for ${this.scenario}`)
  }
}
