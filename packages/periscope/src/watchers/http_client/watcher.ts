/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { Buffer } from 'node:buffer'
import { subscribe, unsubscribe, type ChannelListener } from 'node:diagnostics_channel'

import { IncomingEntry } from '../../entry.ts'
import { BatchScope } from '../../recorder/context.ts'
import type { Redactor } from '../../recorder/redactor.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { BatchContext, Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { HttpClientEntryContent } from './types.ts'

const CHANNELS = {
  create: 'undici:request:create',
  headers: 'undici:request:headers',
  trailers: 'undici:request:trailers',
  error: 'undici:request:error',
} as const

const ALWAYS_REDACT_HEADERS: Record<string, true> = {
  'authorization': true,
  'proxy-authorization': true,
  'cookie': true,
  'cookie2': true,
  'set-cookie': true,
  'set-cookie2': true,
}

type StructuralRequest = object

type RequestState = {
  context: BatchContext
  startedAt: bigint
  method: string
  url: string
  requestHeaders?: Record<string, unknown>
  responseHeaders?: Record<string, unknown>
  status?: number
  finalized: boolean
}

type SelfAddress = {
  dashboardPath: string
  host?: string
  port?: number
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object'
}

function readField(value: unknown, key: string): unknown {
  if (!isObject(value)) {
    return undefined
  }

  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function requestFrom(message: unknown): StructuralRequest | undefined {
  const request = readField(message, 'request')
  return isObject(request) ? request : undefined
}

function headerPart(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8')
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8')
  }

  return undefined
}

function appendHeader(target: Record<string, unknown>, rawName: unknown, rawValue: unknown): void {
  const name = headerPart(rawName)?.trim().toLowerCase()
  if (!name) {
    return
  }

  const values = Array.isArray(rawValue) ? rawValue.map(headerPart) : [headerPart(rawValue)]
  const present = values.filter((value): value is string => value !== undefined)
  if (present.length === 0) {
    return
  }

  const value: unknown = present.length === 1 ? present[0] : present
  const current = target[name]
  if (current === undefined) {
    target[name] = value
  } else if (Array.isArray(current)) {
    target[name] = current.concat(present)
  } else {
    target[name] = [current, ...present]
  }
}

function parseHeaderBlock(target: Record<string, unknown>, block: string): void {
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) {
      continue
    }

    appendHeader(target, line.slice(0, separator), line.slice(separator + 1).trim())
  }
}

/**
 * Undici has used both a CRLF string and a flat name/value byte array for headers. Accept those
 * shapes, tuple arrays, and plain records without depending on Undici's private Request class.
 */
function parseHeaders(value: unknown): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = Object.create(null)
  const block = headerPart(value)

  if (block !== undefined) {
    parseHeaderBlock(result, block)
  } else if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index]
      if (Array.isArray(item)) {
        appendHeader(result, item[0], item[1])
        continue
      }

      if (index + 1 < value.length) {
        appendHeader(result, item, value[index + 1])
        index += 1
      }
    }
  } else if (isObject(value)) {
    for (const [name, item] of Object.entries(value)) {
      appendHeader(result, name, item)
    }
  }

  return Object.keys(result).length === 0 ? undefined : result
}

function redactHeaders(
  value: unknown,
  redactor: Redactor,
  replacement: string
): Record<string, unknown> | undefined {
  const parsed = parseHeaders(value)
  if (parsed === undefined) {
    return undefined
  }

  const serialized = safeSerialize(parsed)
  if (!isObject(serialized) || Array.isArray(serialized)) {
    return undefined
  }

  const mandatory: Record<string, unknown> = Object.create(null)
  for (const [name, item] of Object.entries(serialized)) {
    mandatory[name] = Object.hasOwn(ALWAYS_REDACT_HEADERS, name.toLowerCase()) ? replacement : item
  }

  return redactor.redactHeaders(mandatory)
}

function redactUrl(raw: string, replacement: string): { value: string; parsed?: URL } {
  try {
    const parsed = new URL(raw)
    const original = Array.from(parsed.searchParams)
    parsed.search = ''
    for (const [key] of original) {
      parsed.searchParams.append(key, replacement)
    }
    return { value: parsed.toString(), parsed }
  } catch {
    const queryStart = raw.indexOf('?')
    if (queryStart === -1) {
      return { value: raw }
    }

    const fragmentStart = raw.indexOf('#', queryStart)
    const queryEnd = fragmentStart === -1 ? raw.length : fragmentStart
    const parameters = new URLSearchParams(raw.slice(queryStart + 1, queryEnd))
    const redacted = new URLSearchParams()
    for (const [key] of parameters) {
      redacted.append(key, replacement)
    }

    const fragment = fragmentStart === -1 ? '' : raw.slice(fragmentStart)
    return { value: `${raw.slice(0, queryStart)}?${redacted.toString()}${fragment}` }
  }
}

function requestUrl(
  request: StructuralRequest,
  replacement: string
): { value: string; parsed?: URL } {
  const originValue = readField(request, 'origin')
  const origin =
    readString(originValue) ??
    readString(readField(originValue, 'href')) ??
    readString(readField(request, 'url'))
  const path = readString(readField(request, 'path'))

  if (origin !== undefined) {
    try {
      const absolute = path === undefined ? new URL(origin) : new URL(path, origin)
      return redactUrl(absolute.toString(), replacement)
    } catch {
      return redactUrl(path === undefined ? origin : `${origin}${path}`, replacement)
    }
  }

  const protocol = readString(readField(request, 'protocol'))
  const host = readString(readField(request, 'host'))
  if (protocol !== undefined && host !== undefined) {
    return redactUrl(`${protocol}//${host}${path ?? '/'}`, replacement)
  }

  return redactUrl(path ?? '[Unknown URL]', replacement)
}

function readStatus(response: unknown): number | undefined {
  const raw = readField(response, 'statusCode') ?? readField(response, 'status')
  const status = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isInteger(status) && status >= 100 && status <= 999 ? status : undefined
}

function normalizeHost(host: string | undefined): string | undefined {
  const normalized = host
    ?.trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  return normalized === '' ? undefined : normalized
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host)
  if (normalized === 'localhost' || normalized === '::1') {
    return true
  }

  return normalized !== undefined && /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function matchesSelfHost(configuredHost: string | undefined, requestHost: string): boolean {
  const normalizedConfiguredHost = normalizeHost(configuredHost)
  if (normalizedConfiguredHost === undefined) {
    return false
  }

  return normalizedConfiguredHost === '0.0.0.0' || normalizedConfiguredHost === '::'
    ? isLoopbackHost(requestHost)
    : normalizedConfiguredHost === normalizeHost(requestHost)
}

function readPort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined
  }

  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
}

function effectivePort(url: URL): number | undefined {
  if (url.port !== '') {
    return readPort(url.port)
  }

  if (url.protocol === 'http:') {
    return 80
  }
  if (url.protocol === 'https:') {
    return 443
  }

  return undefined
}

function isDashboardRequest(url: URL | undefined, self: SelfAddress): boolean {
  if (
    url === undefined ||
    self.port === undefined ||
    !matchesSelfHost(self.host, url.hostname) ||
    effectivePort(url) !== self.port
  ) {
    return false
  }

  const pathMatches =
    self.dashboardPath === '/' ||
    url.pathname === self.dashboardPath ||
    url.pathname.startsWith(`${self.dashboardPath}/`)
  return pathMatches
}

/**
 * Observe Undici's diagnostics channels without importing or patching Undici itself.
 */
export class HttpClientWatcher implements Watcher {
  readonly name = WatcherName.HTTP_CLIENT

  readonly #context: WatcherContext
  readonly #self: SelfAddress
  readonly #requests = new WeakMap<StructuralRequest, RequestState>()
  readonly #activeRequests = new Set<StructuralRequest>()
  readonly #flushes = new Set<Promise<void>>()
  #registered = false

  readonly #onCreate: ChannelListener = (message) => {
    safeguard('periscope.watcher.http_client.create', () => this.#create(message))
  }

  readonly #onHeaders: ChannelListener = (message) => {
    safeguard('periscope.watcher.http_client.headers', () => this.#headers(message))
  }

  readonly #onTrailers: ChannelListener = (message) => {
    safeguard('periscope.watcher.http_client.trailers', () => this.#finalize(message, true))
  }

  readonly #onError: ChannelListener = (message) => {
    safeguard('periscope.watcher.http_client.error', () => this.#finalize(message, false))
  }

  constructor(context: WatcherContext) {
    this.#context = context
    this.#self = {
      dashboardPath: context.config.dashboard.path,
      host: process.env.HOST,
      port: readPort(process.env.PORT),
    }
  }

  register(): void {
    if (this.#registered) {
      return
    }

    let subscribed = 0
    safeguard('periscope.watcher.http_client.register', () => {
      try {
        subscribe(CHANNELS.create, this.#onCreate)
        subscribed++
        subscribe(CHANNELS.headers, this.#onHeaders)
        subscribed++
        subscribe(CHANNELS.trailers, this.#onTrailers)
        subscribed++
        subscribe(CHANNELS.error, this.#onError)
        subscribed++
        this.#registered = true
      } finally {
        if (!this.#registered) {
          const subscriptions = [
            [CHANNELS.create, this.#onCreate],
            [CHANNELS.headers, this.#onHeaders],
            [CHANNELS.trailers, this.#onTrailers],
            [CHANNELS.error, this.#onError],
          ] as const
          for (const [channel, listener] of subscriptions.slice(0, subscribed)) {
            unsubscribe(channel, listener)
          }
        }
      }
    })
  }

  async cleanup(): Promise<void> {
    if (this.#registered) {
      this.#registered = false
      const subscriptions = [
        [CHANNELS.create, this.#onCreate],
        [CHANNELS.headers, this.#onHeaders],
        [CHANNELS.trailers, this.#onTrailers],
        [CHANNELS.error, this.#onError],
      ] as const

      for (const [channel, listener] of subscriptions) {
        safeguard('periscope.watcher.http_client.unsubscribe', () => {
          unsubscribe(channel, listener)
        })
      }
    }

    for (const request of this.#activeRequests) {
      const state = this.#requests.get(request)
      if (state !== undefined) {
        state.finalized = true
      }
      this.#requests.delete(request)
    }
    this.#activeRequests.clear()

    await Promise.all(this.#flushes)
  }

  #create(message: unknown): void {
    const request = requestFrom(message)
    if (request === undefined || this.#requests.has(request)) {
      return
    }

    const { recorder, config } = this.#context
    const url = requestUrl(request, config.redact.replacement)
    if (isDashboardRequest(url.parsed, this.#self)) {
      return
    }

    this.#requests.set(request, {
      context: recorder.captureContext(),
      startedAt: process.hrtime.bigint(),
      method: (readString(readField(request, 'method')) ?? 'GET').toUpperCase(),
      url: url.value,
      requestHeaders: redactHeaders(
        readField(request, 'headers'),
        recorder.redactor,
        config.redact.replacement
      ),
      finalized: false,
    })
    this.#activeRequests.add(request)
  }

  #headers(message: unknown): void {
    const request = requestFrom(message)
    if (request === undefined) {
      return
    }

    const state = this.#requests.get(request)
    if (state === undefined || state.finalized) {
      return
    }

    const response = readField(message, 'response')
    const status = readStatus(response)
    if (status !== undefined) {
      state.status = status
    }

    const headers = redactHeaders(
      readField(response, 'headers'),
      this.#context.recorder.redactor,
      this.#context.config.redact.replacement
    )
    if (headers !== undefined) {
      state.responseHeaders = headers
    }
  }

  #finalize(message: unknown, completed: boolean): void {
    const request = requestFrom(message)
    if (request === undefined) {
      return
    }

    const state = this.#requests.get(request)
    if (state === undefined || state.finalized) {
      return
    }

    state.finalized = true
    this.#requests.delete(request)
    this.#activeRequests.delete(request)

    const duration = process.hrtime.bigint() - state.startedAt
    const error = completed ? undefined : readField(message, 'error')
    const content: HttpClientEntryContent = {
      method: state.method,
      url: state.url,
      ...(state.status === undefined ? {} : { status: state.status }),
      durationMs: Math.max(0, Number(duration) / 1_000_000),
      ...(state.requestHeaders === undefined ? {} : { requestHeaders: state.requestHeaders }),
      ...(state.responseHeaders === undefined ? {} : { responseHeaders: state.responseHeaders }),
      ...(error === undefined ? {} : { error: safeSerialize(error) }),
      completed,
    }

    const entry = IncomingEntry.make(EntryType.HTTP_CLIENT, content).withTags(
      `method:${state.method}`,
      state.status === undefined ? undefined : `status:${state.status}`
    )

    BatchScope.runWith(state.context, () => {
      this.#context.recorder.record(entry)
    })

    /**
     * An outbound response may finish while its originating request is still active or after an
     * earlier fragment streamed. Marking this boundary intermediate preserves sampled-in
     * streaming while an undecided sampled-out context defers the entry to its request's final
     * retention decision.
     */
    const flushing = this.#context.recorder.flush(state.context, 'intermediate')
    this.#flushes.add(flushing)
    void flushing.then(() => this.#flushes.delete(flushing))
  }
}
