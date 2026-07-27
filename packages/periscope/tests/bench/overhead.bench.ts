/*
 * periscope
 *
 * Phase 8 performance gate. This file is intentionally executable instead of a Japa spec:
 * latency and soak measurements need an isolated playground process, not the test runner's heap.
 */

import { spawn } from 'node:child_process'
import { Agent, createServer, get as httpGet } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import autocannon from 'autocannon'
import { measure } from 'mitata'

import { defineConfig } from '../../src/define_config.ts'
import { IncomingEntry } from '../../src/entry.ts'
import { BatchScope } from '../../src/recorder/context.ts'
import { Recorder } from '../../src/recorder/recorder.ts'
import { MemoryStore } from '../../src/storage/memory_store.ts'
import { EntryType } from '../../src/types.ts'

interface StoredBaseline {
  version: number
  regressionTolerancePercent: number
  recordMedianMicros: number
  latencyDeltaMs: number
  throughputLossPercent: number
  rssGrowthMb: number
}

interface LoadResult {
  p99Ms: number
  requestsPerSecond: number
  errors: number
  non2xx: number
}

interface ServerHandle {
  pid: number
  url: string
  stop(): Promise<void>
}

const PACKAGE_ROOT = resolve(import.meta.dirname, '../..')
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '../..')
const PLAYGROUND_ROOT = resolve(REPOSITORY_ROOT, 'playground')
const SQLITE_PATH = resolve(PLAYGROUND_ROOT, 'tmp/periscope.sqlite')
const BASELINE_PATH = resolve(import.meta.dirname, 'baseline.json')

const LOAD_SECONDS = positiveInteger('PERISCOPE_BENCH_DURATION_SECONDS', 30)
const SOAK_SECONDS = positiveInteger('PERISCOPE_SOAK_SECONDS', 600)
const SOAK_WARMUP_SECONDS = positiveInteger('PERISCOPE_SOAK_WARMUP_SECONDS', 60)
const CONNECTIONS = positiveInteger('PERISCOPE_BENCH_CONNECTIONS', 20)
const LATENCY_RATE = positiveInteger('PERISCOPE_BENCH_LATENCY_RPS', 5)
const LOAD_RATE = positiveInteger('PERISCOPE_BENCH_RPS', 200)
const SOAK_RATE = positiveInteger('PERISCOPE_SOAK_RPS', 200)
const LATENCY_SAMPLES = LATENCY_RATE * LOAD_SECONDS

if (LATENCY_SAMPLES < 150) {
  throw new Error(
    'The p99 latency gate requires at least 150 paired samples; increase ' +
      'PERISCOPE_BENCH_DURATION_SECONDS or PERISCOPE_BENCH_LATENCY_RPS'
  )
}

const HARD_BUDGETS = {
  latencyDeltaMs: 1,
  throughputLossPercent: 5,
  rssGrowthMb: 30,
  recordMedianMicros: 20,
} as const

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback

  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(raw)}`)
  }

  return value
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a local TCP port'))
        return
      }

      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
  })
}

function status(url: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const request = httpGet(url, (response) => {
      response.resume()
      response.once('end', () => resolveStatus(response.statusCode ?? 0))
    })
    request.once('error', reject)
    request.setTimeout(2_000, () => request.destroy(new Error(`Timed out requesting ${url}`)))
  })
}

async function waitUntilReady(url: string, exited: Promise<never>): Promise<void> {
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    const probe = status(`${url}/ok`).then((code) => {
      if (code !== 200) throw new Error(`Playground readiness probe returned HTTP ${code}`)
    })

    try {
      await Promise.race([probe, exited])
      return
    } catch {
      await Promise.race([delay(100), exited])
    }
  }

  throw new Error(`Playground did not become ready at ${url} within 30 seconds`)
}

async function startPlayground(enabled: boolean): Promise<ServerHandle> {
  const port = await availablePort()
  const output: string[] = []
  const child = spawn(process.execPath, ['build/bin/server.js'], {
    cwd: PLAYGROUND_ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'fatal',
      APP_KEY: 'periscope-benchmark-app-key-0001',
      APP_URL: `http://127.0.0.1:${port}`,
      SESSION_DRIVER: 'memory',
      NODE_ENV: 'production',
      PERISCOPE_ENABLED: enabled ? 'true' : 'false',
      PERISCOPE_BENCH_STORAGE: 'memory',
      PLAYGROUND_DB_PATH: resolve(PLAYGROUND_ROOT, 'tmp/db.sqlite3'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const capture = (chunk: Buffer) => {
    output.push(chunk.toString())
    if (output.length > 200) output.shift()
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)

  const exited = new Promise<never>((_, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(
        new Error(
          `Playground exited before shutdown (code=${code}, signal=${signal})\n${output.join('')}`
        )
      )
    })
  })
  const url = `http://127.0.0.1:${port}`
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return

    child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
      delay(5_000).then(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }),
    ])
  }

  try {
    await waitUntilReady(url, exited)
  } catch (error) {
    await stop()
    throw new Error(`Playground failed readiness at ${url}\n${output.join('')}`, { cause: error })
  }

  return {
    pid: child.pid!,
    url,
    stop,
  }
}

async function runLoad(
  url: string,
  duration: number,
  overallRate?: number,
  connections = CONNECTIONS
): Promise<LoadResult> {
  const result = await autocannon({
    url: `${url}/ok`,
    connections,
    duration,
    overallRate,
    pipelining: 1,
    timeout: 10,
    bailout: 1,
  })

  return {
    p99Ms: result.latency.p99,
    requestsPerSecond: result.requests.average,
    errors: result.errors + result.timeouts,
    non2xx: result.non2xx,
  }
}

function requestDuration(url: string, agent: Agent): Promise<number> {
  return new Promise((resolveDuration, reject) => {
    const started = performance.now()
    const request = httpGet(`${url}/ok`, { agent }, (response) => {
      response.resume()
      response.once('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Latency probe returned HTTP ${response.statusCode ?? 0}`))
          return
        }

        resolveDuration(performance.now() - started)
      })
    })
    request.once('error', reject)
    request.setTimeout(2_000, () =>
      request.destroy(new Error(`Timed out measuring request latency at ${url}`))
    )
  })
}

function percentile(values: number[], fraction: number): number {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

async function measurePairedP99(
  baselineUrl: string,
  enabledUrl: string
): Promise<{ baseline: number; enabled: number; delta: number }> {
  const samples = LATENCY_SAMPLES
  const baseline: number[] = []
  const enabled: number[] = []
  const baselineAgent = new Agent({ keepAlive: true, maxSockets: 1 })
  const enabledAgent = new Agent({ keepAlive: true, maxSockets: 1 })

  try {
    for (let index = 0; index < samples; index += 1) {
      const iterationStarted = performance.now()
      /**
       * Autocannon's latency histogram is integer milliseconds, which cannot enforce a strict
       * sub-millisecond delta. Start paired high-resolution probes together so scheduler drift and
       * host load affect both modes during the same observation window, then pace the next pair to
       * the configured low-contention latency rate.
       */
      const [baselineDuration, enabledDuration] = await Promise.all([
        requestDuration(baselineUrl, baselineAgent),
        requestDuration(enabledUrl, enabledAgent),
      ])
      baseline.push(baselineDuration)
      enabled.push(enabledDuration)
      const remainingIntervalMs = 1_000 / LATENCY_RATE - (performance.now() - iterationStarted)
      if (remainingIntervalMs > 0) await delay(remainingIntervalMs)
    }
  } finally {
    baselineAgent.destroy()
    enabledAgent.destroy()
  }

  const windowDeltas: number[] = []
  for (let offset = 0; offset < samples; offset += 50) {
    const baselineP99 = percentile(baseline.slice(offset, offset + 50), 0.99)
    const enabledP99 = percentile(enabled.slice(offset, offset + 50), 0.99)
    windowDeltas.push(enabledP99 - baselineP99)
  }

  return {
    baseline: percentile(baseline, 0.99),
    enabled: percentile(enabled, 0.99),
    /**
     * Report the median repeated-window p99 delta. A single whole-run p99 subtraction compares two
     * unrelated scheduler/GC outliers and regularly invents tens of milliseconds of "overhead"
     * while fixed-rate throughput is unchanged.
     */
    delta: percentile(windowDeltas, 0.5),
  }
}

function rssMb(pid: number): number {
  const statusText = readFileSync(`/proc/${pid}/status`, 'utf8')
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(statusText)
  if (match === null) throw new Error(`VmRSS is absent from /proc/${pid}/status`)

  return Number(match[1]) / 1_024
}

async function benchmarkRecordPath(): Promise<number> {
  const config = defineConfig({
    storage: { driver: 'memory' },
    recording: { caps: { log: Number.MAX_SAFE_INTEGER } },
  })
  const recorder = new Recorder({ config, store: new MemoryStore() })
  const context = BatchScope.createContext('request')
  const entry = IncomingEntry.make(EntryType.LOG, { message: 'benchmark', level: 40 })
  const batchSize = 100

  const stats = await BatchScope.runWith(context, () =>
    measure(
      () => {
        for (let index = 0; index < batchSize; index += 1) recorder.record(entry)
        context.buffer.length = 0
        context.counters.log = 0
      },
      {
        min_samples: 50,
        max_samples: 500,
        min_cpu_time: 500_000_000,
        warmup_samples: 10,
      }
    )
  )

  return stats.p50 / batchSize / 1_000
}

async function warmServer(url: string): Promise<void> {
  const result = await runLoad(url, 5, LOAD_RATE)
  if (result.errors + result.non2xx > 0) {
    throw new Error(`HTTP warmup had failures: ${JSON.stringify(result)}`)
  }
}

async function benchmarkHttpOverhead(): Promise<{
  baseline: LoadResult
  enabled: LoadResult
  latencyDeltaMs: number
  throughputLossPercent: number
}> {
  rmSync(SQLITE_PATH, { force: true })
  const baselineServer = await startPlayground(false)
  let enabledServer: ServerHandle
  try {
    enabledServer = await startPlayground(true)
  } catch (error) {
    await baselineServer.stop()
    throw error
  }

  try {
    await warmServer(baselineServer.url)
    await warmServer(enabledServer.url)

    const latency = await measurePairedP99(baselineServer.url, enabledServer.url)
    const baselineThroughput = await runLoad(baselineServer.url, LOAD_SECONDS, LOAD_RATE)
    const enabledThroughput = await runLoad(enabledServer.url, LOAD_SECONDS, LOAD_RATE)
    const baseline = { ...baselineThroughput, p99Ms: latency.baseline }
    const enabled = { ...enabledThroughput, p99Ms: latency.enabled }

    if (baseline.errors + baseline.non2xx + enabled.errors + enabled.non2xx > 0) {
      throw new Error(
        `HTTP benchmark had failures: baseline=${JSON.stringify(baseline)}, enabled=${JSON.stringify(enabled)}`
      )
    }

    return {
      baseline,
      enabled,
      latencyDeltaMs: latency.delta,
      throughputLossPercent:
        ((baseline.requestsPerSecond - enabled.requestsPerSecond) / baseline.requestsPerSecond) *
        100,
    }
  } finally {
    await Promise.all([baselineServer.stop(), enabledServer.stop()])
  }
}

async function benchmarkSoak(): Promise<number> {
  rmSync(SQLITE_PATH, { force: true })
  const server = await startPlayground(true)

  try {
    await runLoad(server.url, SOAK_WARMUP_SECONDS, SOAK_RATE)
    const before = rssMb(server.pid)
    const result = await runLoad(server.url, SOAK_SECONDS, SOAK_RATE)
    const after = rssMb(server.pid)

    if (result.errors + result.non2xx > 0) {
      throw new Error(`Soak benchmark had failures: ${JSON.stringify(result)}`)
    }

    return Math.max(0, after - before)
  } finally {
    await server.stop()
  }
}

function assertBelow(label: string, value: number, limit: number, failures: string[]): void {
  if (!Number.isFinite(value) || value >= limit) {
    failures.push(`${label}: ${value.toFixed(3)} (must be < ${limit.toFixed(3)})`)
  }
}

async function main(): Promise<void> {
  const stored = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as StoredBaseline
  if (stored.version !== 1)
    throw new Error(`Unsupported performance baseline version ${stored.version}`)

  const recordMedianMicros = await benchmarkRecordPath()
  const http = await benchmarkHttpOverhead()
  const rssGrowthMb = await benchmarkSoak()
  const throughputLossPercent = Math.max(0, http.throughputLossPercent)
  const latencyDeltaMs = Math.max(0, http.latencyDeltaMs)
  const tolerance = 1 + stored.regressionTolerancePercent / 100

  const measurements = {
    recordMedianMicros,
    latencyDeltaMs,
    throughputLossPercent,
    rssGrowthMb,
    baseline: http.baseline,
    enabled: http.enabled,
    loadSeconds: LOAD_SECONDS,
    soakSeconds: SOAK_SECONDS,
    soakWarmupSeconds: SOAK_WARMUP_SECONDS,
    soakRate: SOAK_RATE,
  }
  console.log(JSON.stringify(measurements, null, 2))

  const failures: string[] = []
  assertBelow('record() median (µs)', recordMedianMicros, HARD_BUDGETS.recordMedianMicros, failures)
  assertBelow('p99 latency delta (ms)', latencyDeltaMs, HARD_BUDGETS.latencyDeltaMs, failures)
  assertBelow(
    'throughput loss (%)',
    throughputLossPercent,
    HARD_BUDGETS.throughputLossPercent,
    failures
  )
  assertBelow('RSS growth (MB)', rssGrowthMb, HARD_BUDGETS.rssGrowthMb, failures)

  assertBelow(
    'record() median regression (µs)',
    recordMedianMicros,
    stored.recordMedianMicros * tolerance,
    failures
  )
  assertBelow(
    'p99 latency regression (ms)',
    latencyDeltaMs,
    stored.latencyDeltaMs * tolerance,
    failures
  )
  assertBelow(
    'throughput regression (%)',
    throughputLossPercent,
    stored.throughputLossPercent * tolerance,
    failures
  )
  assertBelow('RSS regression (MB)', rssGrowthMb, stored.rssGrowthMb * tolerance, failures)

  if (failures.length > 0) {
    throw new Error(`Performance gate failed:\n- ${failures.join('\n- ')}`)
  }
}

await main()
