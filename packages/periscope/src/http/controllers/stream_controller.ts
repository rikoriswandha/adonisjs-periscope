/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { PassThrough } from 'node:stream'
import { clearInterval, setInterval } from 'node:timers'

import type { HttpContext } from '@adonisjs/core/http'

import { safeguardAsync } from '../../safeguard.ts'
import type { FlushFanout, FlushedEvent, PeriscopeStore, StoredEntry } from '../../types.ts'
import { firstQueryString } from '../query.ts'

const DEFAULT_MAX_STREAM_CLIENTS = 5
const KEEPALIVE_INTERVAL_MS = 15_000
const CONNECTED_FRAME = ': connected\n\n'
const KEEPALIVE_FRAME = ': keepalive\n\n'

type StreamClient = {
  application?: string
  body: PassThrough
  close: () => void
  disconnect: () => void
  pending: FlushedEvent[]
  replaying: boolean
}

type StreamControllerOptions = {
  keepaliveIntervalMs?: number
  maxClients?: number
}

function syntheticFlush(entry: StoredEntry): FlushedEvent {
  return {
    type: entry.type,
    uuid: entry.uuid,
    indexRow: {
      uuid: entry.uuid,
      batchId: entry.batchId,
      application: entry.application,
      type: entry.type,
      familyHash: entry.familyHash,
      tags: entry.tags,
      shouldDisplayOnIndex: true,
      sequence: entry.sequence.toString(),
      createdAt: entry.createdAt.toISOString(),
    },
  }
}

/**
 * Fans flush events out to the bounded set of live dashboard connections.
 *
 * A client is subscribed before its replay read begins so flushes cannot disappear in the gap
 * between storage and live delivery. Those events wait on that client until its historical rows
 * have been written, preserving the browser's monotonic event stream.
 */
export class StreamController {
  readonly #clients = new Set<StreamClient>()
  #unsubscribeFlushed?: () => void
  #keepalive?: NodeJS.Timeout
  readonly #keepaliveIntervalMs: number
  readonly #maxClients: number

  constructor(
    private readonly deps: { fanout: FlushFanout; store: PeriscopeStore },
    options: StreamControllerOptions
  ) {
    this.#keepaliveIntervalMs = options.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS
    this.#maxClients = options.maxClients ?? DEFAULT_MAX_STREAM_CLIENTS
  }

  async stream({ request, response }: HttpContext): Promise<void> {
    if (this.#clients.size >= this.#maxClients) {
      response.header('Retry-After', '5')
      response.tooManyRequests({ error: 'Too many active Periscope stream clients' })
      return
    }

    const application = firstQueryString(request.qs().application)
    const lastEventId =
      request.header('last-event-id') ?? firstQueryString(request.qs().lastEventId)
    const body = new PassThrough()
    let closed = false
    const client: StreamClient = {
      application,
      body,
      close: () => {
        if (closed) return
        closed = true

        request.request.removeListener('aborted', client.close)
        response.response.removeListener('close', client.close)
        response.response.removeListener('finish', client.close)
        body.removeListener('close', client.close)
        body.removeListener('error', client.close)
        this.#clients.delete(client)
        body.destroy()
        this.#stopFanoutWhenIdle()
      },
      disconnect: () => {
        client.close()
        response.response.destroy()
      },
      pending: [],
      replaying: lastEventId !== undefined,
    }

    request.request.once('aborted', client.close)
    response.response.once('close', client.close)
    response.response.once('finish', client.close)
    body.once('close', client.close)
    body.once('error', client.close)
    this.#clients.add(client)

    try {
      this.#startFanout()
    } catch {
      client.close()
      response.serviceUnavailable({ error: 'Periscope live stream is unavailable' })
      return
    }

    response.header('Content-Type', 'text/event-stream; charset=utf-8')
    response.header('Cache-Control', 'no-cache, no-transform')
    response.header('Connection', 'keep-alive')
    response.header('X-Accel-Buffering', 'no')
    body.write(CONNECTED_FRAME)
    response.stream(body)

    if (lastEventId === undefined) return

    const replay = await safeguardAsync('periscope.stream.replay', () =>
      this.deps.store.list({
        afterSequence: lastEventId,
        direction: 'asc',
        displayOnIndex: true,
        limit: 200,
        ...(application === undefined ? {} : { application }),
      })
    )

    if (!this.#clients.has(client)) return

    for (const entry of replay?.data ?? []) {
      if (!this.#writeClientFrame(client, this.#flushFrame(syntheticFlush(entry)))) return
    }

    client.replaying = false
    for (const event of client.pending) {
      if (!this.#writeClientFrame(client, this.#flushFrame(event))) return
    }
    client.pending.length = 0
  }

  #startFanout(): void {
    if (this.#unsubscribeFlushed === undefined) {
      this.#unsubscribeFlushed = this.deps.fanout.subscribe((event) => this.#broadcast(event))
    }

    if (this.#keepalive === undefined) {
      this.#keepalive = setInterval(
        () => this.#writeFrame(KEEPALIVE_FRAME),
        this.#keepaliveIntervalMs
      )
      this.#keepalive.unref()
    }
  }

  #stopFanoutWhenIdle(): void {
    if (this.#clients.size !== 0) return

    if (this.#keepalive !== undefined) {
      clearInterval(this.#keepalive)
      this.#keepalive = undefined
    }

    const unsubscribe = this.#unsubscribeFlushed
    this.#unsubscribeFlushed = undefined
    unsubscribe?.()
  }

  #broadcast(event: FlushedEvent): void {
    for (const client of this.#clients) {
      if (client.application !== undefined && client.application !== event.indexRow.application) {
        continue
      }

      if (client.replaying) {
        client.pending.push(event)
      } else {
        this.#writeClientFrame(client, this.#flushFrame(event))
      }
    }
  }

  #flushFrame(event: FlushedEvent): string {
    return `event: flush\nid: ${event.indexRow.sequence}\ndata: ${JSON.stringify(event)}\n\n`
  }

  #writeClientFrame(client: StreamClient, frame: string): boolean {
    if (client.body.write(frame)) return true
    client.disconnect()
    return false
  }

  #writeFrame(frame: string): void {
    for (const client of this.#clients) {
      this.#writeClientFrame(client, frame)
    }
  }
}
