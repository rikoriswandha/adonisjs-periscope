/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { PassThrough } from 'node:stream'
import { clearInterval, setInterval } from 'node:timers'

import type { HttpContext } from '@adonisjs/core/http'

import type { Recorder } from '../../recorder/recorder.ts'
import type { FlushedEvent } from '../../types.ts'

const MAX_STREAM_CLIENTS = 5
const KEEPALIVE_INTERVAL_MS = 15_000
const CONNECTED_FRAME = ': connected\n\n'
const KEEPALIVE_FRAME = ': keepalive\n\n'

type StreamClient = {
  body: PassThrough
  close: () => void
  disconnect: () => void
}

/**
 * Fans recorder flush notifications out to the bounded set of live dashboard connections.
 */
export class StreamController {
  readonly #clients = new Set<StreamClient>()
  #unsubscribeFlushed?: () => void
  #keepalive?: NodeJS.Timeout

  constructor(
    private readonly recorder: Pick<Recorder, 'subscribeFlushed'>,
    private readonly keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS
  ) {}

  stream({ request, response }: HttpContext): void {
    if (this.#clients.size >= MAX_STREAM_CLIENTS) {
      response.header('Retry-After', '5')
      response.tooManyRequests({ error: 'Too many active Periscope stream clients' })
      return
    }

    const body = new PassThrough()
    let closed = false
    const client: StreamClient = {
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
  }

  #startFanout(): void {
    if (this.#unsubscribeFlushed === undefined) {
      this.#unsubscribeFlushed = this.recorder.subscribeFlushed((event) => this.#broadcast(event))
    }

    if (this.#keepalive === undefined) {
      this.#keepalive = setInterval(
        () => this.#writeFrame(KEEPALIVE_FRAME),
        this.keepaliveIntervalMs
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
    this.#writeFrame(`event: flush\ndata: ${JSON.stringify(event)}\n\n`)
  }

  #writeFrame(frame: string): void {
    for (const client of this.#clients) {
      if (!client.body.write(frame)) {
        client.disconnect()
      }
    }
  }
}
