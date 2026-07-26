/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getActiveTest, test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import type { HttpContext } from '@adonisjs/core/http'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import { setActiveWatcher } from '../../../src/watchers/active.ts'
import { attachRequestBatch, markIgnoredRequest } from '../../../src/watchers/http_batch.ts'
import { withPeriscope } from '../../../src/watchers/exception/mixin.ts'
import { codeFrame, parseStack } from '../../../src/watchers/exception/stack.ts'
import type { ExceptionEntryContent } from '../../../src/watchers/exception/types.ts'
import { ExceptionWatcher } from '../../../src/watchers/exception/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

async function makeWatcher(captureProcessErrors: boolean = false) {
  const { app, emitter } = await createApp()
  const config = defineConfig({
    storage: { driver: 'memory' },
    watchers: {
      exception: {
        captureCodeFrame: 'never',
        captureProcessErrors,
      },
    },
  })
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const watcher = new ExceptionWatcher({ app, emitter, recorder, config, dev: true })

  watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())

  return { recorder, store, watcher }
}

function makeHttpContext(): HttpContext {
  const ctx = new HttpContextFactory().merge({ method: 'GET', url: '/boom?from=test' }).create()

  /**
   * The upstream factory's `route` option only interpolates params into the request URL; it does
   * not assign `ctx.route`. A real server assigns the full object after matching, while this
   * watcher reads only the two fields below.
   */
  ctx.route = { pattern: '/boom' } as HttpContext['route']
  return ctx
}

function parkedRequest(ctx: HttpContext) {
  const context = BatchScope.createContext('request')
  attachRequestBatch(ctx, { context, startedHeapUsed: 0 })
  return context
}

function reportFromOneCallSite(watcher: ExceptionWatcher, message: string): void {
  watcher.report(new Error(message))
}

test.group('ExceptionWatcher | exception handler mixin', () => {
  test('record before preserving the application handler report call and return value', async ({
    assert,
  }) => {
    const { watcher } = await makeWatcher()
    const ctx = makeHttpContext()
    const request = parkedRequest(ctx)
    const delegated = { handled: true }

    class FakeHandler {
      calls: Array<{ error: unknown; ctx: HttpContext }> = []

      report(error: unknown, context: HttpContext) {
        this.calls.push({ error, ctx: context })
        return delegated
      }
    }

    const Handler = withPeriscope(FakeHandler)
    const handler = new Handler()
    const error = new Error('controller failed')
    const result = handler.report(error, ctx)

    assert.strictEqual(result, delegated)
    assert.deepEqual(handler.calls, [{ error, ctx }])
    assert.lengthOf(request.buffer, 1)
    assert.equal(request.buffer[0].type, EntryType.EXCEPTION)
    assert.equal(request.buffer[0].content.message, 'controller failed')
    assert.strictEqual(request.buffer[0].batchId, request.batchId)
    assert.strictEqual(watcher.name, 'exception')
  })

  test('delegate even when Periscope recording itself fails', async ({ assert }) => {
    const { watcher } = await makeWatcher()
    watcher.report = () => {
      throw new Error('broken capture')
    }

    class FakeHandler {
      calls = 0

      report(_error: unknown, _ctx: HttpContext) {
        this.calls++
        return 'application reporter completed'
      }
    }

    const Handler = withPeriscope(FakeHandler)
    const handler = new Handler()

    assert.doesNotThrow(() => handler.report(new Error('host failure'), makeHttpContext()))
    assert.equal(handler.calls, 1)
  })

  test('remain a transparent passthrough when no exception watcher is active', ({ assert }) => {
    setActiveWatcher('exception', null)
    const ctx = makeHttpContext()
    const delegated = Symbol('delegated')

    class FakeHandler {
      calls = 0

      report(_error: unknown, _ctx: HttpContext) {
        this.calls++
        return delegated
      }
    }

    const Handler = withPeriscope(FakeHandler)
    const handler = new Handler()

    assert.strictEqual(handler.report('not an error', ctx), delegated)
    assert.equal(handler.calls, 1)
  })
})

test.group('ExceptionWatcher | capture', () => {
  test('re-enter the request batch parked on a context outside its ALS scope', async ({
    assert,
  }) => {
    const { watcher } = await makeWatcher()
    const ctx = makeHttpContext()
    const request = parkedRequest(ctx)

    assert.isUndefined(BatchScope.current())
    watcher.report(new Error('outside middleware'), ctx)

    assert.lengthOf(request.buffer, 1)
    assert.strictEqual(request.buffer[0].batchId, request.batchId)
    assert.deepEqual(request.buffer[0].content.request, {
      method: 'GET',
      url: '/boom?from=test',
      route: { pattern: '/boom' },
    })
  })

  test('drop exceptions attributed to dashboard requests instead of using the ambient batch', async ({
    assert,
  }) => {
    const { watcher } = await makeWatcher()
    const ctx = makeHttpContext()
    const ambient = BatchScope.createContext('test')
    markIgnoredRequest(ctx)

    BatchScope.runWith(ambient, () => {
      watcher.report(new Error('dashboard route was not found'), ctx)
    })

    assert.isEmpty(ambient.buffer)
  })

  test('group the same message from one call site and split a different message', async ({
    assert,
  }) => {
    const { watcher } = await makeWatcher()
    const context = BatchScope.createContext('test')

    BatchScope.runWith(context, () => {
      reportFromOneCallSite(watcher, 'same failure')
      reportFromOneCallSite(watcher, 'same failure')
      reportFromOneCallSite(watcher, 'different failure')
    })

    assert.lengthOf(context.buffer, 3)
    assert.isNotNull(context.buffer[0].familyHash)
    assert.equal(context.buffer[0].familyHash, context.buffer[1].familyHash)
    assert.notEqual(context.buffer[0].familyHash, context.buffer[2].familyHash)
  })

  test('capture strings and plain objects without throwing or losing their detail', async ({
    assert,
  }) => {
    const { watcher } = await makeWatcher()
    const context = BatchScope.createContext('test')

    BatchScope.runWith(context, () => {
      assert.doesNotThrow(() => watcher.report('plain string failure'))
      assert.doesNotThrow(() => watcher.report({ reason: 'plain object failure', attempt: 2 }))
    })

    const contents = context.buffer.map((entry) => entry.content as ExceptionEntryContent)
    assert.equal(contents[0].name, 'String')
    assert.equal(contents[0].message, 'plain string failure')
    assert.equal(contents[0].context, 'plain string failure')
    assert.equal(contents[1].name, 'Object')
    assert.equal(contents[1].message, '{"reason":"plain object failure","attempt":2}')
    assert.deepEqual(contents[1].context, { reason: 'plain object failure', attempt: 2 })
  })

  test('bound the raw stack string and retain an explicit truncation marker', async ({
    assert,
  }) => {
    const { watcher } = await makeWatcher()
    const context = BatchScope.createContext('test')
    const error = new Error('oversized stack')
    error.stack = `Error: oversized stack\n    at fail (/app/fail.ts:1:1)\n${'é'.repeat(40_000)}`

    BatchScope.runWith(context, () => watcher.report(error))

    const content = context.buffer[0].content as ExceptionEntryContent
    assert.isAtMost(Buffer.byteLength(content.stack, 'utf8'), 64 * 1024)
    assert.include(content.stack, '[Periscope truncated this stack at the 64 KiB storage limit.]')
  })

  test('classify dependency and Node built-in stack frames', ({ assert }) => {
    const frames = parseStack(
      [
        'Error: failed',
        '    at run (/workspace/node_modules/pkg/index.js:12:4)',
        '    at emit (node:events:519:28)',
        '    at app (file:///workspace/app/service.ts:7:3)',
      ].join('\n')
    )

    assert.deepEqual(
      frames.map((frame) => frame.type),
      ['module', 'native', 'app']
    )
    assert.equal(frames[2].file, '/workspace/app/service.ts')
  })

  test('parse eval, bare, file URL, async, anonymous and native V8 frame shapes honestly', ({
    assert,
  }) => {
    const frames = parseStack(
      [
        'Error: failed',
        '    at eval (eval at run (/app/src/x.ts:10:5), <anonymous>:1:9)',
        '    at /app/src/bare.ts:2:3',
        '    at async load (file:///app/src/async.ts:4:5)',
        '    at async /app/src/direct.ts:6:7',
        '    at invoke (<anonymous>:8:9)',
        '    at Array.map (native)',
      ].join('\n')
    )

    assert.deepEqual(
      frames.map(({ file, function: functionName, type }) => ({ file, functionName, type })),
      [
        { file: '<anonymous>', functionName: 'eval', type: 'native' },
        { file: '/app/src/bare.ts', functionName: null, type: 'app' },
        { file: '/app/src/async.ts', functionName: 'load', type: 'app' },
        { file: '/app/src/direct.ts', functionName: null, type: 'app' },
        { file: '<anonymous>', functionName: 'invoke', type: 'native' },
        { file: 'native', functionName: 'Array.map', type: 'native' },
      ]
    )
  })

  test('read a bounded radius around an application frame and swallow missing files', ({
    assert,
  }) => {
    const directory = mkdtempSync(join(tmpdir(), 'periscope-exception-'))
    const file = join(directory, 'source.ts')
    writeFileSync(
      file,
      Array.from({ length: 20 }, (_, index) => `source line ${index + 1}`).join('\n')
    )
    getActiveTest()?.cleanup(() => rmSync(directory, { recursive: true, force: true }))

    const source = codeFrame({
      file,
      line: 10,
      column: 1,
      function: 'fail',
      type: 'app',
      raw: `at fail (${file}:10:1)`,
    })

    assert.lengthOf(source!, 11)
    assert.deepEqual(source![0], { line: 5, source: 'source line 5', highlight: false })
    assert.deepEqual(source![5], { line: 10, source: 'source line 10', highlight: true })
    assert.deepEqual(source![10], { line: 15, source: 'source line 15', highlight: false })
    assert.isUndefined(
      codeFrame({
        file: join(directory, 'missing.ts'),
        line: 1,
        column: 1,
        function: null,
        type: 'app',
        raw: '',
      })
    )
  })

  test('observe escalated rejections without installing a rejection handler', async ({
    assert,
  }) => {
    const rejectionListeners = new Set(process.listeners('unhandledRejection'))
    const monitorListeners = new Set(process.listeners('uncaughtExceptionMonitor'))
    const { store } = await makeWatcher(true)
    const addedRejectionListeners = process
      .listeners('unhandledRejection')
      .filter((listener) => !rejectionListeners.has(listener))
    const observer = process
      .listeners('uncaughtExceptionMonitor')
      .find((listener) => !monitorListeners.has(listener))

    assert.isEmpty(addedRejectionListeners)
    assert.exists(observer)
    observer!(new Error('detached rejection'), 'unhandledRejection')
    await new Promise<void>((resolve) => setImmediate(resolve))

    const entries = await store.list({ type: EntryType.EXCEPTION })
    assert.lengthOf(entries.data, 1)
    assert.equal(entries.data[0].content.message, 'detached rejection')
    assert.equal(entries.data[0].content.origin, 'unhandledRejection')
    assert.include(entries.data[0].tags, 'origin:unhandledRejection')
  })

  test('notify every process observer owner until that owner uninstalls', async ({ assert }) => {
    const monitorListeners = new Set(process.listeners('uncaughtExceptionMonitor'))
    const first = await makeWatcher(true)
    const second = await makeWatcher(true)
    const observer = process
      .listeners('uncaughtExceptionMonitor')
      .find((listener) => !monitorListeners.has(listener))

    assert.exists(observer)
    observer!(new Error('shared process failure'), 'uncaughtException')
    await new Promise<void>((resolve) => setImmediate(resolve))

    let firstEntries = await first.store.list({ type: EntryType.EXCEPTION })
    let secondEntries = await second.store.list({ type: EntryType.EXCEPTION })
    assert.lengthOf(firstEntries.data, 1)
    assert.lengthOf(secondEntries.data, 1)

    first.watcher.cleanup()
    assert.include(process.listeners('uncaughtExceptionMonitor'), observer!)
    observer!(new Error('remaining owner failure'), 'uncaughtException')
    await new Promise<void>((resolve) => setImmediate(resolve))

    firstEntries = await first.store.list({ type: EntryType.EXCEPTION })
    secondEntries = await second.store.list({ type: EntryType.EXCEPTION })
    assert.lengthOf(firstEntries.data, 1)
    assert.lengthOf(secondEntries.data, 2)

    second.watcher.cleanup()
    assert.notInclude(process.listeners('uncaughtExceptionMonitor'), observer!)
  })
})
