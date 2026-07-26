/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import { LoggerManager } from '@adonisjs/core/logger'
import type { LoggerService } from '@adonisjs/core/types'
import { LoggerFactory } from '@adonisjs/logger/factories'
import type { LoggerConfig, LoggerManagerConfig } from '@adonisjs/logger/types'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import type { LogLevelName } from '../../../src/types.ts'
import { periscopeLogStream } from '../../../src/watchers/log/stream.ts'
import { LogWatcher } from '../../../src/watchers/log/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

/**
 * Build the real recorder pipeline around a small memory store. The stream tests assert against
 * the active batch instead of booting an application: pino writes synchronously, so the buffer is
 * the exact value that reached the recorder after serialisation and redaction.
 */
function createStreamHarness(level: LogLevelName = 'warn') {
  const config = defineConfig({
    storage: { driver: 'memory' },
    watchers: { log: { level } },
  })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const stream = periscopeLogStream({ recorder, level: config.watchers.log.level })
  const logger = new LoggerFactory()
    .merge({ enabled: true, level: 'trace', destination: stream })
    .create()

  getActiveTest()?.cleanup(() => recorder.shutdown())

  return { config, logger, recorder, stream }
}

/**
 * Read pino's destination through the same stable description used by the watcher. Keeping this
 * helper local makes the cleanup assertion compare object identity without importing pino solely
 * for its private stream symbol.
 */
function destinationOf(logger: { pino: object }): unknown {
  const symbol = Object.getOwnPropertySymbols(logger.pino).find(
    (candidate) => candidate.description === 'pino.stream'
  )

  if (symbol === undefined) {
    return undefined
  }

  return (logger.pino as unknown as Record<symbol, unknown>)[symbol]
}

test.group('periscopeLogStream', () => {
  test('record warn and drop info at the default threshold', ({ assert }) => {
    const { logger, stream } = createStreamHarness()
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      logger.info('routine chatter')
      logger.warn('something needs attention')
    })

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].type, EntryType.LOG)
    assert.equal(context.buffer[0].content.level, 'warn')
    assert.equal(context.buffer[0].content.levelNumber, 40)
    assert.equal(context.buffer[0].content.message, 'something needs attention')
    assert.deepEqual(stream.stats, { recorded: 1 })
  })

  test('exclude the periscope.internal child channel', ({ assert }) => {
    const { logger, stream } = createStreamHarness()
    const context = BatchScope.createContext('request')
    const internal = logger.child({ name: 'periscope.internal' })

    BatchScope.runWith(context, () => internal.error('store failed'))

    assert.lengthOf(context.buffer, 0)
    assert.deepEqual(stream.stats, { recorded: 0 })
  })

  test('serialize the merging object as redacted context without pino noise', ({ assert }) => {
    const { logger } = createStreamHarness()
    const context = BatchScope.createContext('request')
    const requestLogger = logger.child({
      name: 'application',
      request_id: 'req-42',
      hostname: 'not-context',
    })

    BatchScope.runWith(context, () => {
      requestLogger.error({ password: 'x', operation: 'checkout' }, 'boom')
    })

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].content.message, 'boom')
    assert.deepEqual(context.buffer[0].content.context, {
      request_id: 'req-42',
      password: '[REDACTED]',
      operation: 'checkout',
    })
    assert.isNumber(context.buffer[0].content.time)
  })

  test('respect a lower configured level using numeric pino levels', ({ assert }) => {
    const { logger } = createStreamHarness('debug')
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      logger.trace('too detailed')
      logger.debug('diagnostic detail')
    })

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].content.level, 'debug')
    assert.equal(context.buffer[0].content.levelNumber, 20)
    assert.equal(context.buffer[0].content.message, 'diagnostic detail')
  })

  test('join the active request batch', ({ assert }) => {
    const { logger } = createStreamHarness()
    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => logger.error('request failed'))

    assert.lengthOf(context.buffer, 1)
    assert.equal(context.buffer[0].batchId, context.batchId)
    assert.equal(context.buffer[0].content.message, 'request failed')
  })
})

test.group('LogWatcher', () => {
  test('tee both logger-manager pino roots and restore every original destination', async ({
    assert,
  }) => {
    const mainDestination = { write(_line: string): void {} }
    const auditDestination = { write(_line: string): void {} }
    const loggerConfig: LoggerManagerConfig<Record<string, LoggerConfig>> = {
      default: 'main',
      loggers: {
        main: { enabled: true, level: 'trace', destination: mainDestination },
        audit: { enabled: true, level: 'trace', destination: auditDestination },
        disabled: { enabled: false },
      },
    }
    const manager = new LoggerManager(loggerConfig)
    const main = manager.use('main')
    const audit = manager.use('audit')
    const disabled = manager.use('disabled')
    const managerOriginal = destinationOf(manager)
    const mainOriginal = destinationOf(main)
    const auditOriginal = destinationOf(audit)
    const { app, emitter } = await createApp({ config: { logger: loggerConfig } })

    /**
     * The throwaway app deliberately registers no providers. This binding recreates the one core's
     * app provider supplies in production; the generic application augmentation is unavailable in
     * this isolated package test, hence the narrow conversion to its declared service contract.
     */
    app.container.singleton('logger', () => manager as unknown as LoggerService)

    const config = defineConfig({ storage: { driver: 'memory' } })
    const store = new MemoryStore({ maxEntries: 100 })
    const recorder = new Recorder({ config, store })
    const watcher = new LogWatcher({ app, emitter, recorder, config, dev: true })

    getActiveTest()?.cleanup(async () => {
      watcher.cleanup()
      await recorder.shutdown()
    })

    await watcher.register()

    assert.notStrictEqual(destinationOf(manager), managerOriginal)
    assert.notStrictEqual(destinationOf(main), mainOriginal)
    assert.notStrictEqual(destinationOf(audit), auditOriginal)
    assert.isUndefined(destinationOf(disabled))

    const context = BatchScope.createContext('request')

    BatchScope.runWith(context, () => {
      manager.warn('via manager')
      main.warn('via default use')
      audit.error('via named logger')
    })

    assert.lengthOf(context.buffer, 3)
    assert.deepEqual(watcher.stats, { recorded: 3 })

    watcher.cleanup()
    watcher.cleanup()

    assert.strictEqual(destinationOf(manager), managerOriginal)
    assert.strictEqual(destinationOf(main), mainOriginal)
    assert.strictEqual(destinationOf(audit), auditOriginal)

    BatchScope.runWith(context, () => manager.warn('after cleanup'))
    assert.lengthOf(context.buffer, 3)
  })

  test('skip cleanly when the application has no logger binding', async ({ assert }) => {
    const { app, emitter } = await createApp()
    const config = defineConfig({ storage: { driver: 'memory' } })
    const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
    const watcher = new LogWatcher({ app, emitter, recorder, config, dev: true })

    getActiveTest()?.cleanup(() => recorder.shutdown())

    await assert.doesNotReject(() => watcher.register())
    assert.deepEqual(watcher.stats, { recorded: 0 })
  })
})
