/*
 * Booted security drill. It intentionally runs outside Japa because NODE_ENV and the
 * provider's process-wide listener registrations must be fixed before the application imports.
 */

import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

interface ResponseSnapshot {
  status: number
  body: string
}

interface ServerHandle {
  origin: string
  stop(): Promise<void>
}

interface RawRequestOptions {
  method?: string
  headers?: Record<string, string>
}

const PLAYGROUND_ROOT = resolve(import.meta.dirname, '../..')
const SQLITE_PATH = resolve(PLAYGROUND_ROOT, 'tmp/periscope.sqlite')

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a local port'))
        return
      }

      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
  })
}

function fetchRaw(
  origin: string,
  path: string,
  options: RawRequestOptions = {}
): Promise<ResponseSnapshot> {
  const target = new URL(origin)

  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        port: Number(target.port),
        method: options.method ?? 'GET',
        path,
        headers: { accept: 'text/html,application/json', ...options.headers },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.once('end', () => {
          resolveResponse({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      }
    )
    request.once('error', reject)
    request.setTimeout(2_000, () => request.destroy(new Error(`Timed out requesting ${path}`)))
    request.end()
  })
}

async function start(
  nodeEnv: 'production' | 'development',
  enabled: boolean
): Promise<ServerHandle> {
  const port = await availablePort()
  const output: string[] = []
  const child = spawn(process.execPath, ['--import=@poppinss/ts-exec', 'bin/server.ts'], {
    cwd: PLAYGROUND_ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: nodeEnv,
      PERISCOPE_ENABLED: enabled ? 'true' : 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = (chunk: Buffer) => {
    output.push(chunk.toString())
    if (output.length > 200) output.shift()
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)

  const origin = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Playground exited during boot\n${output.join('')}`)
    }

    try {
      const response = await fetchRaw(origin, '/ok')
      if (response.status === 200) break
    } catch {
      // The socket is expected to refuse connections until Adonis starts listening.
    }

    await delay(100)
  }

  if (Date.now() >= deadline) {
    child.kill('SIGKILL')
    throw new Error(`Playground did not start within 30 seconds\n${output.join('')}`)
  }

  return {
    origin,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      await Promise.race([
        new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
        delay(5_000).then(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }),
      ])
    },
  }
}

function assertStatus(label: string, response: ResponseSnapshot, expected: number): void {
  if (response.status !== expected) {
    throw new Error(
      `${label}: expected HTTP ${expected}, received ${response.status}\n${response.body}`
    )
  }
}

async function productionGate(): Promise<void> {
  rmSync(SQLITE_PATH, { force: true })
  const server = await start('production', false)

  try {
    assertStatus('host route', await fetchRaw(server.origin, '/ok'), 200)
    assertStatus('dashboard shell', await fetchRaw(server.origin, '/periscope'), 404)
    assertStatus('dashboard API', await fetchRaw(server.origin, '/periscope/api/entries'), 404)
    assertStatus(
      'production traversal request',
      await fetchRaw(server.origin, '/periscope/assets/%2e%2e/%2e%2e/config/periscope.ts'),
      404
    )
  } finally {
    await server.stop()
  }

  if (existsSync(SQLITE_PATH)) {
    throw new Error(
      'Production-disabled Periscope created tmp/periscope.sqlite; the zero-listener/store gate regressed'
    )
  }
}

async function enabledProductionAuthorizationGate(): Promise<void> {
  const server = await start('production', true)

  try {
    assertStatus('production dashboard shell', await fetchRaw(server.origin, '/periscope'), 403)
    assertStatus(
      'production dashboard API',
      await fetchRaw(server.origin, '/periscope/api/entries'),
      403
    )
  } finally {
    await server.stop()
  }
}

async function enabledTraversalGate(): Promise<void> {
  const server = await start('development', true)

  try {
    const response = await fetchRaw(
      server.origin,
      '/periscope/assets/%2e%2e/%2e%2e/config/periscope.ts'
    )
    assertStatus('enabled traversal request', response, 404)

    if (response.body.includes('defineConfig') || response.body.includes('storage:')) {
      throw new Error('Traversal response disclosed playground/config/periscope.ts')
    }
    assertStatus(
      'drive-by clear request',
      await fetchRaw(server.origin, '/periscope/api/clear', { method: 'POST' }),
      403
    )
    assertStatus(
      'same-site clear request',
      await fetchRaw(server.origin, '/periscope/api/clear', {
        method: 'POST',
        headers: {
          'sec-fetch-site': 'same-site',
          'x-periscope-request': 'dashboard',
        },
      }),
      403
    )
    assertStatus(
      'dashboard clear request',
      await fetchRaw(server.origin, '/periscope/api/clear', {
        method: 'POST',
        headers: {
          'sec-fetch-site': 'same-origin',
          'x-periscope-request': 'dashboard',
        },
      }),
      204
    )
  } finally {
    await server.stop()
  }
}

await productionGate()
await enabledProductionAuthorizationGate()
await enabledTraversalGate()
console.log('Production authorization, mutation protection, and path-traversal drills passed')
