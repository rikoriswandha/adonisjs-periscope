/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { IncomingEntry } from '../../entry.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { MailEntryContent, MailEventMap, MailLifecycle } from './types.ts'

const MAX_BODY_BYTES = 256 * 1024
const MAX_MAILER_BYTES = 512
const MIME_HEADER_SCAN_BYTES = 64 * 1024
const TRUNCATION_MARKER = '[Truncated]'
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8')

/** The exact slice of the shared emitter used by @adonisjs/mail 10. */
type MailEventSource = {
  on<Event extends keyof MailEventMap>(
    event: Event,
    listener: (payload: MailEventMap[Event]) => void
  ): () => void
}

type BoundedText = {
  value: string
  truncated: boolean
}

type BoundedRawMime = BoundedText & {
  encoding?: 'base64'
}

/** Read application-owned properties without trusting getters or proxy traps. */
function readProperty(value: unknown, property: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined
  }

  try {
    return Reflect.get(value, property)
  } catch {
    return undefined
  }
}

/**
 * Bound a string without splitting a Unicode code point. `forceTruncated` is used for buffers
 * whose sampled prefix fits after decoding even though bytes remain beyond the sample.
 */
function boundString(value: string, maxBytes: number, forceTruncated = false): BoundedText {
  const prefixBudget = Math.max(0, maxBytes - TRUNCATION_MARKER_BYTES)
  let consumedBytes = 0
  let prefixEnd = 0
  let truncated = forceTruncated

  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)
    if (codePoint === undefined) {
      break
    }

    const codeUnits = codePoint > 0xffff ? 2 : 1
    consumedBytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4

    if (consumedBytes <= prefixBudget) {
      prefixEnd = index + codeUnits
    }

    if (consumedBytes > maxBytes) {
      truncated = true
      break
    }

    index += codeUnits
  }

  return truncated
    ? { value: `${value.slice(0, prefixEnd)}${TRUNCATION_MARKER}`, truncated: true }
    : { value, truncated: false }
}

/** Convert only in-memory UTF-8-compatible values. Streams, paths and href bodies are not read. */
function boundText(value: unknown): BoundedText | undefined {
  if (typeof value === 'string') {
    return boundString(value, MAX_BODY_BYTES)
  }

  if (Buffer.isBuffer(value)) {
    const sampledBytes = Math.min(value.byteLength, MAX_BODY_BYTES + 4)
    const sample = value.subarray(0, sampledBytes).toString('utf8')
    return boundString(sample, MAX_BODY_BYTES, value.byteLength > MAX_BODY_BYTES)
  }

  return undefined
}

/**
 * Nodemailer also accepts `{ content }` body values. Capture in-memory content, but never follow a
 * path, URL or stream supplied by an application.
 */
function renderedBody(value: unknown): BoundedText | undefined {
  const direct = boundText(value)
  if (direct !== undefined) {
    return direct
  }

  return boundText(readProperty(value, 'content'))
}

function serializedString(value: unknown, maxBytes?: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const serialized =
    maxBytes === undefined ? safeSerialize(value) : safeSerialize(value, { maxBytes })
  return typeof serialized === 'string' ? serialized : undefined
}

function serializedValue(value: unknown): unknown {
  return value === undefined ? undefined : safeSerialize(value)
}

/**
 * Prefer transport-computed and explicit envelopes, but still make ordinary message addressing
 * visible for lifecycle events whose transport has not produced an envelope.
 */
function ordinaryMessageEnvelope(message: unknown): unknown {
  const explicit = readProperty(message, 'envelope')
  if (explicit !== undefined) {
    return explicit
  }

  const envelope: Record<string, unknown> = {}
  let hasAddress = false

  for (const property of ['from', 'to', 'cc', 'bcc'] as const) {
    const value = readProperty(message, property)
    if (value !== undefined) {
      envelope[property] = value
      hasAddress = true
    }
  }

  return hasAddress ? envelope : undefined
}

/**
 * Nodemailer's JSON transport exposes its JSON document as `original.message`, the same property
 * some stream-like transports use for an RFC 5322 message. Read only a bounded header prefix and
 * promote the value to `raw` only when that prefix is a valid-looking RFC 5322 header block.
 */
function isRawMime(value: unknown): boolean {
  let sample: string

  if (typeof value === 'string') {
    sample = value.slice(0, MIME_HEADER_SCAN_BYTES)
  } else if (Buffer.isBuffer(value)) {
    sample = value.subarray(0, MIME_HEADER_SCAN_BYTES).toString('utf8')
  } else {
    return false
  }

  if (sample.includes('\0')) {
    return false
  }

  const separator = /\r?\n\r?\n/.exec(sample)
  if (separator?.index === undefined || separator.index === 0) {
    return false
  }

  const headerLines = sample.slice(0, separator.index).split(/\r?\n/)
  let hasHeader = false
  let hasRecognizedHeader = false

  for (const line of headerLines) {
    if (/^[ \t]/.test(line)) {
      if (!hasHeader) {
        return false
      }
      continue
    }

    const match = /^([\x21-\x39\x3b-\x7e]+):/.exec(line)
    if (match === null) {
      return false
    }

    hasHeader = true
    if (/^(from|to|cc|bcc|subject|date|message-id|mime-version|content-type)$/i.test(match[1])) {
      hasRecognizedHeader = true
    }
  }

  return hasHeader && hasRecognizedHeader
}

function rawMime(response: unknown): BoundedRawMime | undefined {
  const original = readProperty(response, 'original')
  const message = readProperty(original, 'message')

  if (!isRawMime(message)) {
    return undefined
  }

  if (Buffer.isBuffer(message)) {
    const originalBytes = Math.min(message.byteLength, MAX_BODY_BYTES)
    return {
      value: message.subarray(0, originalBytes).toString('base64'),
      encoding: 'base64',
      truncated: message.byteLength > MAX_BODY_BYTES,
    }
  }

  return typeof message === 'string' ? boundString(message, MAX_BODY_BYTES) : undefined
}

export class MailWatcher implements Watcher {
  readonly name = WatcherName.MAIL
  readonly stats = { recorded: 0 }

  readonly #context: WatcherContext
  readonly #unsubscribers: (() => void)[] = []

  constructor(context: WatcherContext) {
    this.#context = context
  }

  readonly #handleSending = (payload: MailEventMap['mail:sending']): void => {
    safeguard('periscope.watcher.mail.sending', () => this.#record('sending', payload))
  }

  readonly #handleSent = (payload: MailEventMap['mail:sent']): void => {
    safeguard('periscope.watcher.mail.sent', () => this.#record('sent', payload))
  }

  readonly #handleQueueing = (payload: MailEventMap['mail:queueing']): void => {
    safeguard('periscope.watcher.mail.queueing', () => this.#record('queueing', payload))
  }

  readonly #handleQueued = (payload: MailEventMap['mail:queued']): void => {
    safeguard('periscope.watcher.mail.queued', () => this.#record('queued', payload))
  }

  readonly #handleQueueError = (payload: MailEventMap['queued:mail:error']): void => {
    safeguard('periscope.watcher.mail.queue_error', () => this.#record('queue_error', payload))
  }

  register(): void {
    if (this.#unsubscribers.length !== 0) {
      return
    }

    const source = this.#context.emitter as unknown as MailEventSource
    this.#unsubscribers.push(source.on('mail:sending', this.#handleSending))
    this.#unsubscribers.push(source.on('mail:sent', this.#handleSent))
    this.#unsubscribers.push(source.on('mail:queueing', this.#handleQueueing))
    this.#unsubscribers.push(source.on('mail:queued', this.#handleQueued))
    this.#unsubscribers.push(source.on('queued:mail:error', this.#handleQueueError))
  }

  cleanup(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0).reverse()) {
      safeguard('periscope.watcher.mail.cleanup', unsubscribe)
    }
  }

  #record(event: MailLifecycle, payload: unknown): void {
    const message = readProperty(payload, 'message')
    const responseValue = readProperty(payload, 'response')
    const mailer =
      serializedString(readProperty(payload, 'mailerName'), MAX_MAILER_BYTES) ?? 'unknown'
    const subject = serializedString(readProperty(message, 'subject'))
    const html = renderedBody(readProperty(message, 'html'))
    const text = renderedBody(readProperty(message, 'text'))
    const raw = rawMime(responseValue)
    const responseEnvelope = readProperty(responseValue, 'envelope')
    const envelope = serializedValue(
      responseEnvelope === undefined ? ordinaryMessageEnvelope(message) : responseEnvelope
    )
    const responseMessageId = serializedString(readProperty(responseValue, 'messageId'))
    const messageId = responseMessageId ?? serializedString(readProperty(message, 'messageId'))
    const metadata = serializedValue(readProperty(payload, 'metaData'))
    const response = serializedValue(responseValue)
    const error = serializedValue(readProperty(payload, 'error'))

    const content: MailEntryContent = {
      event,
      mailer,
      ...(envelope === undefined ? {} : { envelope }),
      ...(subject === undefined ? {} : { subject }),
      ...(html === undefined ? {} : { html: serializedString(html.value, MAX_BODY_BYTES) }),
      ...(text === undefined ? {} : { text: serializedString(text.value, MAX_BODY_BYTES) }),
      ...(raw === undefined ? {} : { raw: raw.value }),
      ...(raw?.encoding === undefined ? {} : { rawEncoding: raw.encoding }),
      ...(messageId === undefined ? {} : { messageId }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(response === undefined ? {} : { response }),
      ...(error === undefined ? {} : { error }),
      ...(html?.truncated || text?.truncated || raw?.truncated ? { truncated: true } : {}),
    }

    this.#context.recorder.record(
      IncomingEntry.make(EntryType.MAIL, content).withTags(`lifecycle:${event}`, `mailer:${mailer}`)
    )
    this.stats.recorded++
  }
}
