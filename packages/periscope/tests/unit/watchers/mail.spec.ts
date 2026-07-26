/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest, test } from '@japa/runner'
import type { EmitterService } from '@adonisjs/core/types'

import { defineConfig } from '../../../src/define_config.ts'
import { BatchScope } from '../../../src/recorder/context.ts'
import { Recorder } from '../../../src/recorder/recorder.ts'
import { MemoryStore } from '../../../src/storage/memory_store.ts'
import { EntryType } from '../../../src/types.ts'
import { EventWatcher } from '../../../src/watchers/event/watcher.ts'
import type { MailEntryContent, MailEventMap } from '../../../src/watchers/mail/types.ts'
import { MailWatcher } from '../../../src/watchers/mail/watcher.ts'
import { createApp } from '../../helpers/app_factory.ts'

type TestEmitter = {
  emit(event: keyof MailEventMap, payload: unknown): Promise<void>
}

async function makeWatcher() {
  const { app, emitter } = await createApp()
  const config = defineConfig({})
  const store = new MemoryStore({ maxEntries: 100 })
  const recorder = new Recorder({ config, store })
  const watcher = new MailWatcher({ app, emitter, recorder, config, dev: true })

  watcher.register()
  getActiveTest()?.cleanup(() => watcher.cleanup())

  return { app, config, emitter, recorder, watcher }
}

async function emitInContext(emitter: EmitterService, events: [keyof MailEventMap, unknown][]) {
  const context = BatchScope.createContext('request')
  const source = emitter as unknown as TestEmitter

  await BatchScope.runWith(context, async () => {
    for (const [event, payload] of events) {
      await source.emit(event, payload)
    }
  })

  return context
}

test.group('MailWatcher', () => {
  test('record every mail 10 lifecycle event with content and semantic tags', async ({
    assert,
  }) => {
    const { emitter, watcher } = await makeWatcher()
    const message = {
      envelope: { from: 'sender@example.test', to: ['person@example.test'] },
      subject: 'Welcome',
      html: '<h1>Hello</h1>',
      text: 'Hello',
      messageId: 'draft-id',
    }
    const response = {
      messageId: 'sent-id',
      envelope: { from: 'sender@example.test', to: ['delivered@example.test'] },
      original: { accepted: ['delivered@example.test'] },
    }
    const queueError = new Error('Queue unavailable')
    const queueMetadata: Record<string, unknown> = { jobId: 'job-1' }
    queueMetadata.self = queueMetadata
    const context = await emitInContext(emitter, [
      ['mail:sending', { mailerName: 'smtp', message, views: {} }],
      ['mail:sent', { mailerName: 'smtp', message, views: {}, response }],
      ['mail:queueing', { mailerName: 'smtp', message, views: {} }],
      ['mail:queued', { mailerName: 'smtp', message, views: {}, metaData: queueMetadata }],
      ['queued:mail:error', { mailerName: 'smtp', metaData: queueMetadata, error: queueError }],
    ])
    const contents = context.buffer.map((entry) => entry.content as unknown as MailEntryContent)

    assert.deepEqual(
      context.buffer.map((entry) => entry.type),
      [EntryType.MAIL, EntryType.MAIL, EntryType.MAIL, EntryType.MAIL, EntryType.MAIL]
    )
    assert.deepEqual(
      contents.map((content) => content.event),
      ['sending', 'sent', 'queueing', 'queued', 'queue_error']
    )
    assert.deepEqual(contents[0], {
      event: 'sending',
      mailer: 'smtp',
      envelope: { from: 'sender@example.test', to: ['person@example.test'] },
      subject: 'Welcome',
      html: '<h1>Hello</h1>',
      text: 'Hello',
      messageId: 'draft-id',
    })
    assert.deepInclude(contents[1], {
      event: 'sent',
      messageId: 'sent-id',
      envelope: { from: 'sender@example.test', to: ['delivered@example.test'] },
      response,
    })
    assert.deepInclude(contents[3], {
      metadata: { jobId: 'job-1', self: '[Circular]' },
    })
    assert.deepInclude(contents[4], {
      event: 'queue_error',
      mailer: 'smtp',
      metadata: { jobId: 'job-1', self: '[Circular]' },
    })
    const serializedError = contents[4].error
    if (
      serializedError === null ||
      typeof serializedError !== 'object' ||
      !('name' in serializedError) ||
      !('message' in serializedError)
    ) {
      throw new Error('Expected a serialized queue error')
    }
    assert.equal(serializedError.name, 'Error')
    assert.equal(serializedError.message, 'Queue unavailable')
    assert.deepEqual(
      context.buffer.map((entry) => entry.tags),
      [
        ['lifecycle:sending', 'mailer:smtp'],
        ['lifecycle:sent', 'mailer:smtp'],
        ['lifecycle:queueing', 'mailer:smtp'],
        ['lifecycle:queued', 'mailer:smtp'],
        ['lifecycle:queue_error', 'mailer:smtp'],
      ]
    )
    assert.deepEqual(watcher.stats, { recorded: 5 })
  })

  test('derive an envelope from ordinary message address fields', async ({ assert }) => {
    const { emitter } = await makeWatcher()
    const context = await emitInContext(emitter, [
      [
        'mail:sent',
        {
          mailerName: 'smtp',
          message: {
            from: 'sender@example.test',
            to: ['primary@example.test'],
            cc: 'copy@example.test',
            bcc: ['hidden@example.test'],
            subject: 'Recipients',
          },
          views: {},
          response: { messageId: 'recipient-id' },
        },
      ],
    ])
    const content = context.buffer[0].content as unknown as MailEntryContent

    assert.deepEqual(content.envelope, {
      from: 'sender@example.test',
      to: ['primary@example.test'],
      cc: 'copy@example.test',
      bcc: ['hidden@example.test'],
    })
  })

  test('cap each rendered body and verified raw MIME independently at 256 KiB', async ({
    assert,
  }) => {
    const { emitter } = await makeWatcher()
    const raw = Buffer.from(
      `From: sender@example.test\r\nTo: person@example.test\r\nSubject: Large\r\nMIME-Version: 1.0\r\n\r\n${'λ'.repeat(180_000)}`
    )
    const context = await emitInContext(emitter, [
      [
        'mail:sent',
        {
          mailerName: 'stream',
          message: {
            subject: 'Large',
            html: 'é'.repeat(180_000),
            text: { content: Buffer.from('🙂'.repeat(100_000)) },
          },
          views: {},
          response: {
            messageId: 'large-id',
            envelope: { from: 'sender@example.test', to: ['person@example.test'] },
            original: { message: raw },
          },
        },
      ],
    ])
    const content = context.buffer[0].content as unknown as MailEntryContent

    assert.isTrue(content.truncated)
    for (const value of [content.html, content.text]) {
      if (typeof value !== 'string') {
        throw new Error('Expected every captured rendered body to be a string')
      }
      assert.isAtMost(Buffer.byteLength(value, 'utf8'), 256 * 1024)
      assert.isAbove(Buffer.byteLength(value, 'utf8'), 250 * 1024)
      assert.isTrue(value.endsWith('[Truncated]'))
    }
    if (typeof content.raw !== 'string') {
      throw new Error('Expected captured raw MIME to be a base64 string')
    }
    const capturedRaw = Buffer.from(content.raw, 'base64')
    assert.equal(content.rawEncoding, 'base64')
    assert.equal(capturedRaw.byteLength, 256 * 1024)
    assert.deepEqual(capturedRaw, raw.subarray(0, 256 * 1024))
  })

  test('preserve non-UTF-8 bytes in Buffer-backed raw MIME', async ({ assert }) => {
    const { emitter } = await makeWatcher()
    const raw = Buffer.concat([
      Buffer.from(
        'From: sender@example.test\r\nTo: person@example.test\r\nContent-Type: text/plain; charset=ISO-8859-1\r\n\r\n'
      ),
      Buffer.from([0xe9]),
    ])
    const context = await emitInContext(emitter, [
      [
        'mail:sent',
        {
          mailerName: 'stream',
          message: { subject: 'Latin-1' },
          views: {},
          response: {
            messageId: 'latin-1-id',
            original: { message: raw },
          },
        },
      ],
    ])
    const content = context.buffer[0].content as unknown as MailEntryContent

    assert.equal(content.rawEncoding, 'base64')
    if (typeof content.raw !== 'string') {
      throw new Error('Expected captured raw MIME to be a base64 string')
    }
    assert.deepEqual(Buffer.from(content.raw, 'base64'), raw)
    assert.notProperty(content, 'truncated')
  })

  test('never expose JSON transport original.message as an EML source', async ({ assert }) => {
    const { emitter } = await makeWatcher()
    const context = await emitInContext(emitter, [
      [
        'mail:sent',
        {
          mailerName: 'json',
          message: { subject: 'JSON transport' },
          views: {},
          response: {
            messageId: 'json-id',
            envelope: { from: 'sender@example.test', to: ['person@example.test'] },
            original: {
              message: JSON.stringify({
                from: 'sender@example.test',
                to: ['person@example.test'],
                subject: 'JSON transport',
                text: 'Not an RFC 5322 document',
              }),
            },
          },
        },
      ],
    ])
    const content = context.buffer[0].content as unknown as MailEntryContent

    assert.notProperty(content, 'raw')
    assert.notProperty(content, 'truncated')
  })

  test('isolate hostile payloads and recorder failures from the emitter', async ({ assert }) => {
    const { emitter, recorder } = await makeWatcher()
    const source = emitter as unknown as TestEmitter
    const hostileMessage = new Proxy(
      { html: { content: '<p>Still visible</p>' } },
      {
        get(target, property, receiver) {
          if (property === 'subject') {
            throw new Error('Host getter failed')
          }
          return Reflect.get(target, property, receiver)
        },
      }
    )
    const context = await emitInContext(emitter, [
      ['mail:sending', { mailerName: 'smtp', message: hostileMessage, views: {} }],
    ])

    assert.deepInclude(context.buffer[0].content, {
      event: 'sending',
      mailer: 'smtp',
      html: '<p>Still visible</p>',
    })
    assert.notProperty(context.buffer[0].content, 'subject')

    recorder.record = () => {
      throw new Error('Recorder failed')
    }
    await assert.doesNotReject(() =>
      source.emit('mail:sending', { mailerName: 'smtp', message: {}, views: {} })
    )
  })

  test('register idempotently, unsubscribe on cleanup, and avoid generic event duplicates', async ({
    assert,
  }) => {
    const { app, config, emitter, recorder, watcher } = await makeWatcher()
    const eventWatcher = new EventWatcher({ app, emitter, recorder, config, dev: true })
    eventWatcher.register()
    getActiveTest()?.cleanup(() => eventWatcher.cleanup())
    watcher.register()

    const beforeCleanup = await emitInContext(emitter, [
      ['mail:sending', { mailerName: 'smtp', message: { subject: 'Once' }, views: {} }],
    ])

    assert.lengthOf(beforeCleanup.buffer, 1)
    assert.equal(beforeCleanup.buffer[0].type, EntryType.MAIL)
    assert.deepEqual(eventWatcher.stats, { recorded: 0, ignored: 1 })

    assert.doesNotThrow(() => {
      watcher.cleanup()
      watcher.cleanup()
    })
    const afterCleanup = await emitInContext(emitter, [
      ['mail:sending', { mailerName: 'smtp', message: { subject: 'Never' }, views: {} }],
    ])

    assert.lengthOf(afterCleanup.buffer, 0)
    assert.deepEqual(eventWatcher.stats, { recorded: 0, ignored: 2 })
  })
})
