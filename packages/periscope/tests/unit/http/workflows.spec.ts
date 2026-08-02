/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { test } from '@japa/runner'
import { HttpContextFactory } from '@adonisjs/core/factories/http'
import type { HttpContext } from '@adonisjs/core/http'

import { defineConfig } from '../../../src/define_config.ts'
import { DashboardController } from '../../../src/http/controllers/dashboard_controller.ts'
import { EntryMetadataController } from '../../../src/http/controllers/entry_metadata_controller.ts'
import { ExceptionGroupsController } from '../../../src/http/controllers/exception_groups_controller.ts'
import { MonitoredTagsController } from '../../../src/http/controllers/monitored_tags_controller.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import type { PeriscopeStore } from '../../../src/types.ts'
import { makeStoredEntry } from '../../storage/contract.ts'

function createContext(
  url: string,
  method: string = 'GET',
  params: Record<string, unknown> = {}
): HttpContext {
  const context = new HttpContextFactory().merge({ url, method }).create()
  context.params = params
  context.route = { pattern: url, params } as unknown as typeof context.route
  return context
}

test.group('Dashboard workflows HTTP API', () => {
  test('set exception state, reopen resolved groups, keep ignored groups, and delete open state', async ({
    assert,
  }) => {
    const store = new MemoryStore()
    const controller = new ExceptionGroupsController(store, 'main')
    const first = makeStoredEntry({
      application: 'main',
      type: EntryType.EXCEPTION,
      familyHash: 'boom',
      createdAt: new Date(Date.now() - 10_000),
    })
    await store.save([first])

    const resolve = createContext('/api/exception-groups/boom/state', 'PUT', {
      familyHash: 'boom',
    })
    resolve.request.updateBody({ state: 'resolved' })
    const resolved = await controller.setState(resolve)
    assert.equal(resolved?.state, 'resolved')
    assert.isString(resolved?.stateUpdatedAt)

    let prefixCalls = 0
    const flagsWithPrefix = store.flagsWithPrefix.bind(store)
    store.flagsWithPrefix = async (prefix) => {
      prefixCalls += 1
      return flagsWithPrefix(prefix)
    }
    let page = await controller.index(createContext('/api/exception-groups'))
    assert.equal(prefixCalls, 1)
    assert.equal(page.data[0].state, 'resolved')
    assert.equal(page.data[0].stateUpdatedAt, resolved?.stateUpdatedAt)

    await store.save([
      makeStoredEntry({
        application: 'main',
        type: EntryType.EXCEPTION,
        familyHash: 'boom',
        createdAt: new Date(Date.now() + 1_000),
      }),
    ])
    page = await controller.index(createContext('/api/exception-groups'))
    assert.equal(page.data[0].state, 'open')
    assert.isNull(page.data[0].stateUpdatedAt)

    const ignore = createContext('/api/exception-groups/boom/state', 'PUT', { familyHash: 'boom' })
    ignore.request.updateBody({ state: 'ignored' })
    await controller.setState(ignore)
    await store.save([
      makeStoredEntry({
        application: 'main',
        type: EntryType.EXCEPTION,
        familyHash: 'boom',
        createdAt: new Date(Date.now() + 2_000),
      }),
    ])
    page = await controller.index(createContext('/api/exception-groups'))
    assert.equal(page.data[0].state, 'ignored')

    const open = createContext('/api/exception-groups/boom/state', 'PUT', { familyHash: 'boom' })
    open.request.updateBody({ state: 'open' })
    assert.deepEqual(await controller.setState(open), {
      familyHash: 'boom',
      state: 'open',
      stateUpdatedAt: null,
    })
    assert.isNull(await store.getFlag('exception-state:main:boom'))

    const invalid = createContext('/api/exception-groups/boom/state', 'PUT', {
      familyHash: 'boom',
    })
    invalid.request.updateBody({ state: 'closed' })
    await controller.setState(invalid)
    assert.equal(invalid.response.getStatus(), 400)
  })

  test('merge-patch entry metadata, reject long notes, list records, and delete a full clear', async ({
    assert,
  }) => {
    const store = new MemoryStore()
    const config = defineConfig({
      storage: { driver: 'memory', retention: { hours: 2 } },
    })
    const controller = new EntryMetadataController(store, config)
    let expiresAt: Date | undefined
    const setFlag = store.setFlag.bind(store)
    store.setFlag = async (name, value, options) => {
      expiresAt = options?.expiresAt
      await setFlag(name, value, options)
    }

    const pin = createContext('/api/entries/entry-1/metadata', 'PUT', { uuid: 'entry-1' })
    pin.request.updateBody({ pinned: true })
    const pinned = await controller.set(pin)
    assert.deepInclude(pinned, { uuid: 'entry-1', pinned: true, note: null })
    assert.isString(pinned?.updatedAt)
    assert.isAtLeast(expiresAt!.getTime(), Date.now() + 2 * 60 * 60 * 1_000 - 100)

    const note = createContext('/api/entries/entry-1/metadata', 'PUT', { uuid: 'entry-1' })
    note.request.updateBody({ note: 'Investigate this request' })
    const merged = await controller.set(note)
    assert.deepInclude(merged, {
      uuid: 'entry-1',
      pinned: true,
      note: 'Investigate this request',
    })
    assert.deepEqual(await controller.index(), { records: [merged] })

    const tooLong = createContext('/api/entries/entry-1/metadata', 'PUT', { uuid: 'entry-1' })
    tooLong.request.updateBody({ note: 'x'.repeat(2_001) })
    await controller.set(tooLong)
    assert.equal(tooLong.response.getStatus(), 400)
    const recordsAfterRejection = await controller.index()
    assert.equal(recordsAfterRejection.records[0].note, 'Investigate this request')

    const clear = createContext('/api/entries/entry-1/metadata', 'PUT', { uuid: 'entry-1' })
    clear.request.updateBody({ pinned: false, note: null })
    assert.deepEqual(await controller.set(clear), {
      uuid: 'entry-1',
      pinned: false,
      note: null,
      updatedAt: null,
    })
    assert.deepEqual(await controller.index(), { records: [] })
    assert.isNull(await store.getFlag('entry-meta:entry-1'))
  })

  test('report diagnostics when available and null for stores without them', async ({ assert }) => {
    const store = new MemoryStore()
    const config = defineConfig({ storage: { driver: 'memory' } })
    const environment = { nodeEnv: 'development', periscopeEnabled: () => undefined }
    const status = await new DashboardController(store, config, environment).status()
    assert.deepEqual(status.store, {
      pendingBatches: 0,
      droppedBatches: 0,
      failedBatches: 0,
      retriedBatches: 0,
    })

    const withoutDiagnostics = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'diagnostics') return undefined
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as PeriscopeStore
    const statusWithoutDiagnostics = await new DashboardController(
      withoutDiagnostics,
      config,
      environment
    ).status()
    assert.isNull(statusWithoutDiagnostics.store)
  })

  test('scope monitored tags to the requested application and default to configured application', async ({
    assert,
  }) => {
    const store = new MemoryStore()
    const controller = new MonitoredTagsController(store, 'main')

    const main = createContext('/api/monitored-tags/slow', 'PUT', { tag: 'slow' })
    await controller.set(main)
    const other = createContext('/api/monitored-tags/mail?application=other', 'PUT', {
      tag: 'mail',
    })
    await controller.set(other)

    assert.deepEqual(await controller.index(createContext('/api/monitored-tags')), {
      data: ['slow'],
    })
    assert.deepEqual(
      await controller.index(createContext('/api/monitored-tags?application=other')),
      { data: ['mail'] }
    )

    const remove = createContext('/api/monitored-tags/mail?application=other', 'DELETE', {
      tag: 'mail',
    })
    await controller.delete(remove)
    assert.deepEqual(
      await controller.index(createContext('/api/monitored-tags?application=other')),
      { data: [] }
    )
    assert.deepEqual(await store.monitoredTags('main'), ['slow'])
  })
})
