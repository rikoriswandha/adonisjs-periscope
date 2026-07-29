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
import type { HealthCheckEntryContent, HealthCheckResult, HealthCheckStatus } from './types.ts'

const MAX_CHECKS = 100
const HEALTH_STATUSES: Record<Exclude<HealthCheckStatus, 'unknown'>, true> = {
  ok: true,
  warning: true,
  error: true,
}

type HealthChecksInstance = {
  run(...args: unknown[]): Promise<unknown>
}

type HealthChecksConstructor = {
  prototype: HealthChecksInstance
}

type HealthModuleLoader = () => Promise<unknown>

type RunPatch = {
  healthChecks: HealthChecksConstructor
  descriptor: PropertyDescriptor
  wrapper: HealthChecksInstance['run']
}

function isMissingHealthModule(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false
  }

  if (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return true
  }

  return (
    error.code === 'ERR_MODULE_NOT_FOUND' &&
    'message' in error &&
    typeof error.message === 'string' &&
    /(?:@adonisjs\/core|@adonisjs\/health)/.test(error.message)
  )
}

function isHealthChecksConstructor(value: unknown): value is HealthChecksConstructor {
  return (
    typeof value === 'function' &&
    typeof value.prototype === 'object' &&
    value.prototype !== null &&
    typeof value.prototype.run === 'function'
  )
}

async function loadHealthChecks(): Promise<unknown> {
  // The framework health subpath is optional at runtime, so a static import would prevent the
  // package from loading in applications whose installed core version does not expose it.
  return import('@adonisjs/core/health')
}

function readProperty(value: unknown, key: string | number): unknown {
  try {
    return value !== null && typeof value === 'object'
      ? (value as Record<string | number, unknown>)[key]
      : undefined
  } catch {
    return undefined
  }
}

function projectReport(report: unknown): unknown {
  const rawChecks = readProperty(report, 'checks')
  const checks: Record<string, unknown>[] = []

  if (Array.isArray(rawChecks)) {
    const count = Math.min(rawChecks.length, MAX_CHECKS)
    for (let index = 0; index < count; index++) {
      const check = readProperty(rawChecks, index)
      checks.push({
        name: readProperty(check, 'name'),
        status: readProperty(check, 'status'),
        durationMs: readProperty(check, 'durationMs') ?? readProperty(check, 'duration'),
        message: readProperty(check, 'message'),
      })
    }
  }

  return safeSerialize({
    isHealthy: readProperty(report, 'isHealthy'),
    status: readProperty(report, 'status'),
    checks,
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normaliseStatus(value: unknown): HealthCheckStatus {
  return typeof value === 'string' && Object.hasOwn(HEALTH_STATUSES, value)
    ? (value as Exclude<HealthCheckStatus, 'unknown'>)
    : 'unknown'
}

function normaliseReport(report: unknown): {
  content: HealthCheckEntryContent
  unhealthy: boolean
} {
  const projected = asRecord(projectReport(report)) ?? {}
  const status = normaliseStatus(projected.status)
  const checks: HealthCheckResult[] = []

  if (Array.isArray(projected.checks)) {
    for (const [index, value] of projected.checks.entries()) {
      const check = asRecord(value)
      if (check === undefined) {
        continue
      }

      const durationMs =
        typeof check.durationMs === 'number' &&
        Number.isFinite(check.durationMs) &&
        check.durationMs >= 0
          ? check.durationMs
          : undefined
      checks.push({
        name: typeof check.name === 'string' ? check.name : `Check ${index + 1}`,
        status: normaliseStatus(check.status),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(typeof check.message === 'string' ? { message: check.message } : {}),
      })
    }
  }

  return {
    content: { status, checks },
    unhealthy: projected.isHealthy === false || status === 'error',
  }
}

/** Observe reports produced by AdonisJS's HealthChecks runner without owning any checks. */
export class HealthCheckWatcher implements Watcher {
  readonly name = WatcherName.HEALTH_CHECK
  readonly stats = { recorded: 0 }

  readonly #context: WatcherContext
  readonly #loader: HealthModuleLoader
  #patch?: RunPatch
  #registration?: Promise<void>
  #registered = false
  #active = false

  constructor(context: WatcherContext, loader: HealthModuleLoader = loadHealthChecks) {
    this.#context = context
    this.#loader = loader
  }

  async register(): Promise<void> {
    if (this.#registered) {
      return this.#registration
    }

    this.#registered = true
    const registration = this.#install()
    this.#registration = registration

    try {
      await registration
    } catch (error) {
      this.#registered = false
      throw error
    } finally {
      if (this.#registration === registration) {
        this.#registration = undefined
      }
    }
  }

  cleanup(): void {
    this.#active = false
    this.#registered = false

    const patch = this.#patch
    this.#patch = undefined
    if (patch !== undefined && patch.healthChecks.prototype.run === patch.wrapper) {
      Object.defineProperty(patch.healthChecks.prototype, 'run', patch.descriptor)
    }
  }

  async #install(): Promise<void> {
    let loaded: unknown
    try {
      loaded = await this.#loader()
    } catch (error) {
      if (isMissingHealthModule(error)) {
        return
      }
      throw error
    }
    const healthChecks = isHealthChecksConstructor(loaded)
      ? loaded
      : loaded !== null && typeof loaded === 'object' && 'HealthChecks' in loaded
        ? loaded.HealthChecks
        : undefined

    if (healthChecks === undefined) {
      return
    }
    if (!isHealthChecksConstructor(healthChecks)) {
      throw new TypeError('@adonisjs/core/health does not export a compatible HealthChecks class')
    }

    const descriptor = Object.getOwnPropertyDescriptor(healthChecks.prototype, 'run')
    if (descriptor === undefined || typeof descriptor.value !== 'function') {
      throw new TypeError('@adonisjs/core/health HealthChecks.run is not an own data method')
    }

    const originalRun = descriptor.value as HealthChecksInstance['run']
    const watcher = this
    const wrapper = async function wrappedPeriscopeHealthCheckRun(
      this: HealthChecksInstance,
      ...args: unknown[]
    ): Promise<unknown> {
      const report = await Reflect.apply(originalRun, this, args)
      if (watcher.#active) {
        safeguard('periscope.watcher.health_check.report', () => watcher.#record(report))
      }
      return report
    }

    this.#active = true
    try {
      Object.defineProperty(healthChecks.prototype, 'run', { ...descriptor, value: wrapper })
      this.#patch = { healthChecks, descriptor, wrapper }
    } catch (error) {
      this.#active = false
      throw error
    }
  }

  #record(report: unknown): void {
    const { content, unhealthy } = normaliseReport(report)
    this.#context.recorder.record(
      IncomingEntry.make(EntryType.HEALTH_CHECK, content).withTags(
        unhealthy ? 'failed' : undefined,
        `status:${content.status}`
      )
    )
    this.stats.recorded++
  }
}
