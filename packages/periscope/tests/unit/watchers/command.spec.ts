/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import { args, BaseCommand, flags, Kernel, ListLoader } from '@adonisjs/core/ace'
import { cliui } from '@poppinss/cliui'

import { defineConfig } from '../../../src/define_config.ts'
import { IncomingEntry } from '../../../src/entry.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { SERIALIZER_DEFAULTS } from '../../../src/recorder/serializer.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import { CommandWatcher } from '../../../src/watchers/command/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

class SuccessfulCommand extends BaseCommand {
  static commandName = 'testing:successful'
  static description = 'Successful command fixture'

  @args.string()
  declare resource: string

  @flags.string()
  declare token?: string

  observedKind?: string
  observedMuted?: boolean

  async run() {
    const batch = BatchScope.current()
    this.observedKind = batch?.kind
    this.observedMuted = batch?.muted

    const recorder = await this.app.container.make(Recorder)
    recorder.record(IncomingEntry.make(EntryType.LOG, { message: `handled ${this.resource}` }))

    return `handled:${this.resource}`
  }
}

class ThrowingCommand extends BaseCommand {
  static commandName = 'testing:throwing'
  static description = 'Throwing command fixture'

  async exec(): Promise<never> {
    this.logger.log('rendered before failure')
    const error = new Error('command exploded')
    this.error = error
    this.exitCode = 17
    throw error
  }
}

class IgnoredCommand extends BaseCommand {
  static commandName = 'testing:ignored'
  static description = 'Ignored command fixture'

  observedKind?: string

  async run() {
    this.observedKind = BatchScope.current()?.kind
    return 'ignored-result'
  }
}

class PeriscopeCommand extends BaseCommand {
  static commandName = 'periscope:probe'
  static description = 'Periscope command fixture'

  observedMuted?: boolean

  async run() {
    this.observedMuted = BatchScope.current()?.muted
    const recorder = await this.app.container.make(Recorder)
    recorder.record(IncomingEntry.make(EntryType.LOG, { message: 'must not be recorded' }))
    return 'periscope-result'
  }
}

class CleanupCommand extends BaseCommand {
  static commandName = 'testing:cleanup'
  static description = 'Cleanup command fixture'

  observedKind?: string

  async run() {
    this.observedKind = BatchScope.current()?.kind
    return 'cleanup-result'
  }
}

const OUTPUT_SECRET = 'sk-1234567890abcdef'

class OutputCommand extends BaseCommand {
  static commandName = 'testing:output'
  static description = 'Output command fixture'

  async run() {
    this.logger.log(`credential ${OUTPUT_SECRET}`)
    this.logger.log('x'.repeat(SERIALIZER_DEFAULTS.maxBytes * 2))
  }
}

const COMMANDS = [
  SuccessfulCommand,
  ThrowingCommand,
  IgnoredCommand,
  PeriscopeCommand,
  CleanupCommand,
  OutputCommand,
]

async function makeWatcher(ignore: string[] = [], captureOutput = true) {
  const config = defineConfig({
    storage: { driver: 'memory' },
    watchers: { command: { ignore, captureOutput } },
  })
  const { app, emitter } = await createApp({ environment: 'console' })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const kernel = new Kernel(app)

  kernel.addLoader(new ListLoader(COMMANDS))
  await kernel.boot()

  app.container.singleton(Recorder, () => recorder)
  app.container.singleton('ace', () => kernel)

  const watcher = new CommandWatcher({ app, emitter, recorder, config, dev: true })
  await watcher.register()

  getActiveTest()?.cleanup(async () => {
    watcher.cleanup()
    await recorder.shutdown()
  })

  return { kernel, recorder, store, watcher }
}

test.group('CommandWatcher', () => {
  test('run the complete command in a command batch and flush its primary entry', async ({
    assert,
  }) => {
    const { kernel, store, watcher } = await makeWatcher()

    const command = await kernel.exec<typeof SuccessfulCommand>('testing:successful', [
      'profile',
      '--token=secret-token',
    ])
    const page = await store.list({ limit: 10 })

    assert.equal(command.result, 'handled:profile')
    assert.equal(command.observedKind, 'command')
    assert.isFalse(command.observedMuted)
    assert.lengthOf(page.data, 2)

    const commandEntry = page.data.find((entry) => entry.type === EntryType.COMMAND)
    const logEntry = page.data.find((entry) => entry.type === EntryType.LOG)
    assert.exists(commandEntry)
    assert.exists(logEntry)
    assert.equal(commandEntry!.batchId, logEntry!.batchId)
    assert.deepInclude(commandEntry!.content, {
      command: 'testing:successful',
      args: ['profile'],
      flags: { token: '[REDACTED]' },
      isMain: false,
      exitCode: 0,
    })
    const durationMs = commandEntry!.content.durationMs
    if (typeof durationMs === 'number') {
      assert.isAtLeast(durationMs, 0)
    } else {
      assert.fail('Expected command duration to be a number')
    }
    assert.deepEqual(commandEntry!.tags, ['command:testing:successful', 'exit:0', 'nested'])
    assert.deepEqual(watcher.stats, { recorded: 1, ignored: 0 })
  })

  test('capture bounded redacted output without replacing the selected renderer', async ({
    assert,
  }) => {
    const { kernel, store } = await makeWatcher()
    const ui = cliui({ mode: 'raw' })
    const originalRenderer = ui.logger.getRenderer()

    await kernel.exec('testing:output', [], { ui })
    const page = await store.list({ limit: 10 })
    const output = page.data[0]?.content.output
    const visibleLogs = ui.logger.getLogs()

    assert.strictEqual(ui.logger.getRenderer(), originalRenderer)
    assert.lengthOf(visibleLogs, 2)
    assert.equal(visibleLogs[0].message, `credential ${OUTPUT_SECRET}`)
    assert.equal(visibleLogs[1].message.length, SERIALIZER_DEFAULTS.maxBytes * 2)
    assert.typeOf(output, 'string')
    if (typeof output !== 'string') {
      assert.fail('Expected captured command output')
      return
    }

    assert.include(output, 'credential [REDACTED]')
    assert.notInclude(output, OUTPUT_SECRET)
    assert.include(output, '[Truncated]')
    assert.isAtMost(Buffer.byteLength(output), SERIALIZER_DEFAULTS.maxBytes)
  })

  test('leave renderer output alone when capture is disabled', async ({ assert }) => {
    const { kernel, store } = await makeWatcher([], false)
    const ui = cliui({ mode: 'raw' })
    const originalRenderer = ui.logger.getRenderer()

    await kernel.exec('testing:output', [], { ui })
    const page = await store.list({ limit: 10 })

    assert.strictEqual(ui.logger.getRenderer(), originalRenderer)
    assert.lengthOf(ui.logger.getLogs(), 2)
    assert.notProperty(page.data[0].content, 'output')
  })

  test('record failures in finally without changing the rejection or exit code', async ({
    assert,
  }) => {
    const { kernel, store, watcher } = await makeWatcher()

    const ui = cliui({ mode: 'raw' })
    const originalRenderer = ui.logger.getRenderer()
    await assert.rejects(() => kernel.exec('testing:throwing', [], { ui }), /command exploded/)
    const page = await store.list({ limit: 10 })

    assert.lengthOf(page.data, 1)
    assert.equal(page.data[0].type, EntryType.COMMAND)
    assert.equal(page.data[0].content.exitCode, 17)
    assert.strictEqual(ui.logger.getRenderer(), originalRenderer)
    assert.equal(page.data[0].content.output, 'rendered before failure\n')
    const recordedError = page.data[0].content.error
    if (recordedError !== null && typeof recordedError === 'object' && 'message' in recordedError) {
      assert.equal(recordedError.message, 'command exploded')
    } else {
      assert.fail('Expected the recorded command error to include its message')
    }
    assert.include(page.data[0].tags, 'exit:17')
    assert.deepEqual(watcher.stats, { recorded: 1, ignored: 0 })
  })

  test('apply configured ignores as exact command names', async ({ assert }) => {
    const { kernel, store, watcher } = await makeWatcher(['testing:ignored'])

    const command = await kernel.exec<typeof IgnoredCommand>('testing:ignored', [])

    assert.equal(command.result, 'ignored-result')
    assert.isUndefined(command.observedKind)
    const ignoredPage = await store.list({ limit: 10 })
    assert.lengthOf(ignoredPage.data, 0)
    assert.deepEqual(watcher.stats, { recorded: 0, ignored: 1 })
  })

  test('mute every periscope command and never record it', async ({ assert }) => {
    const { kernel, store, watcher } = await makeWatcher()

    const command = await kernel.exec<typeof PeriscopeCommand>('periscope:probe', [])

    assert.equal(command.result, 'periscope-result')
    assert.isTrue(command.observedMuted)
    const periscopePage = await store.list({ limit: 10 })
    assert.lengthOf(periscopePage.data, 0)
    assert.deepEqual(watcher.stats, { recorded: 0, ignored: 1 })
  })

  test('make the permanent hook inert and restore a patch live at cleanup', async ({ assert }) => {
    const { kernel, store, watcher } = await makeWatcher()

    kernel.executing(() => watcher.cleanup())
    const command = await kernel.exec<typeof CleanupCommand>('testing:cleanup', [])

    assert.equal(command.result, 'cleanup-result')
    assert.isUndefined(command.observedKind)
    const cleanupPage = await store.list({ limit: 10 })
    assert.lengthOf(cleanupPage.data, 0)
    assert.deepEqual(watcher.stats, { recorded: 0, ignored: 0 })
  })

  test('does not resolve or register Ace outside the console environment', async ({ assert }) => {
    const config = defineConfig({ storage: { driver: 'memory' } })
    const { app, emitter } = await createApp({ environment: 'web' })
    const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 10 }) })
    const watcher = new CommandWatcher({ app, emitter, recorder, config, dev: true })

    await watcher.register()

    assert.isFalse(app.container.hasBinding('ace'))
    assert.deepEqual(watcher.stats, { recorded: 0, ignored: 0 })
  })
})
