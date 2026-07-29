/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import { ViewWatcher } from '../../../src/watchers/view/watcher.ts'
import type { ViewEntryContent } from '../../../src/watchers/view/types.ts'
import { createApp } from '../../helpers/app_factory.ts'

type RenderCallback = (renderer: unknown) => void

class StubEdge {
  readonly callbacks = new Set<RenderCallback>()

  onRender(callback: RenderCallback): void {
    this.callbacks.add(callback)
  }

  createRenderer<T extends object>(renderer: T): T {
    for (const callback of this.callbacks) callback(renderer)
    return renderer
  }
}

async function makeWatcher(edge: StubEdge | undefined, captureDataKeys = true) {
  const { app, emitter } = await createApp()
  const config = defineConfig({ watchers: { view: { captureDataKeys } } })
  const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
  const watcher = new ViewWatcher({ app, emitter, config, recorder, dev: true }, async () => edge)

  await watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())
  return watcher
}

test.group('ViewWatcher', () => {
  test('enables view observation and data-key capture by default', ({ assert }) => {
    assert.deepEqual(defineConfig({}).watchers.view, {
      enabled: true,
      captureDataKeys: true,
    })
  })

  test('records async and sync Edge renders in the active request batch without reading values', async ({
    assert,
  }) => {
    const edge = new StubEdge()
    const watcher = await makeWatcher(edge)
    const renderer = edge.createRenderer({
      async render(_template: string, _data?: Record<string, unknown>) {
        await Promise.resolve()
        return '<main>async</main>'
      },
      renderSync(_template: string, _data?: Record<string, unknown>) {
        return '<main>sync</main>'
      },
    })
    const secretValue = 'value-that-must-never-be-read'
    const context = BatchScope.createContext('request')

    await BatchScope.runWith(context, async () => {
      assert.equal(
        await renderer.render('accounts/profile', { accountId: 42, password: secretValue }),
        '<main>async</main>'
      )
      assert.equal(
        renderer.renderSync('partials/card', { card: { secretValue } }),
        '<main>sync</main>'
      )
    })

    assert.deepEqual(
      context.buffer.map((entry) => entry.type),
      [EntryType.VIEW, EntryType.VIEW]
    )
    assert.deepEqual(
      context.buffer.map((entry) => entry.batchId),
      [context.batchId, context.batchId]
    )

    const first = context.buffer[0].content as ViewEntryContent
    const second = context.buffer[1].content as ViewEntryContent
    assert.equal(first.template, 'accounts/profile')
    assert.deepEqual(first.dataKeys, ['accountId', 'password'])
    assert.equal(second.template, 'partials/card')
    assert.deepEqual(second.dataKeys, ['card'])
    assert.isAtLeast(first.durationMs ?? -1, 0)
    assert.isAtLeast(second.durationMs ?? -1, 0)
    assert.notInclude(JSON.stringify(context.buffer.map((entry) => entry.content)), secretValue)
    assert.deepEqual(context.buffer[0].tags, ['accounts/profile'])
    assert.equal(watcher.stats.recorded, 2)
  })

  test('bounds and redacts the template before using it as content or an exact tag', async ({
    assert,
  }) => {
    const edge = new StubEdge()
    const { app, emitter } = await createApp()
    const config = defineConfig({
      redact: { valuePatterns: [/private-template/g] },
      watchers: { view: { enabled: true } },
    })
    const recorder = new Recorder({ config, store: new MemoryStore({ maxEntries: 100 }) })
    const watcher = new ViewWatcher({ app, emitter, config, recorder, dev: true }, async () => edge)
    await watcher.register()
    getActiveTest()?.cleanup(() => watcher.cleanup())
    const renderer = edge.createRenderer({
      async render(_template: string, _data?: Record<string, unknown>) {
        return 'ok'
      },
      renderSync(_template: string, _data?: Record<string, unknown>) {
        return 'ok'
      },
    })
    const context = BatchScope.createContext('request')

    await BatchScope.runWith(context, async () => {
      await renderer.render('private-template')
      await renderer.render('x'.repeat(5_000))
    })

    assert.equal(context.buffer[0].content.template, '[REDACTED]')
    assert.deepEqual(context.buffer[0].tags, ['[REDACTED]'])
    const boundedTemplate = context.buffer[1].content.template
    if (typeof boundedTemplate !== 'string') throw new TypeError('Expected a bounded template')
    assert.isBelow(boundedTemplate.length, 5_000)
    assert.match(boundedTemplate, /\[Truncated\]$/)
  })

  test('does not inspect data keys when captureDataKeys is disabled', async ({ assert }) => {
    const edge = new StubEdge()
    await makeWatcher(edge, false)
    const renderer = edge.createRenderer({
      async render(_template: string, _data?: Record<string, unknown>) {
        return 'ok'
      },
      renderSync(_template: string, _data?: Record<string, unknown>) {
        return 'ok'
      },
    })
    const hostileData = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('data keys were read')
        },
      }
    )
    const context = BatchScope.createContext('request')

    await assert.doesNotReject(() =>
      BatchScope.runWith(context, () => renderer.render('safe/template', hostileData))
    )

    assert.lengthOf(context.buffer, 1)
    assert.notProperty(context.buffer[0].content, 'dataKeys')
  })

  test('registers the official Edge hook once and becomes inert after cleanup or when Edge is absent', async ({
    assert,
  }) => {
    const edge = new StubEdge()
    const watcher = await makeWatcher(edge)
    await watcher.register()
    assert.equal(edge.callbacks.size, 1)

    const renderer = edge.createRenderer({
      async render(_template: string, _data?: Record<string, unknown>) {
        return 'ok'
      },
      renderSync(_template: string, _data?: Record<string, unknown>) {
        return 'ok'
      },
    })
    const context = BatchScope.createContext('request')

    watcher.cleanup()
    watcher.cleanup()
    await BatchScope.runWith(context, () => renderer.render('after-cleanup'))
    assert.isEmpty(context.buffer)

    const absentWatcher = await makeWatcher(undefined)
    await absentWatcher.register()
    assert.equal(absentWatcher.stats.recorded, 0)
  })
})
