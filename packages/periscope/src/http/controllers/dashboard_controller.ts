/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import { isRecordingEnabled } from '../../define_config.ts'
import { Flag } from '../../types.ts'
import type { PeriscopeStore, ResolvedPeriscopeConfig } from '../../types.ts'
import type { DashboardEnvironment } from '../middleware/authorize.ts'
import { firstQueryString, validIsoDateTime } from '../query.ts'

const DUMP_OPEN_LEASE_FLAG_PATTERN = /^dump-open:[A-Za-z0-9_-]{1,128}$/
const DUMP_OPEN_TTL_MS = 30_000
const STATS_SAMPLE_SIZE = 500
const SLOW_QUERY_FAMILY_LIMIT = 10

function percentile(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? null
}

type SlowQueryFamily = {
  familyHash: string
  sql: string
  count: number
  durationTotal: number
  durationCount: number
  maxDurationMs: number
}

export class DashboardController {
  constructor(
    private readonly store: PeriscopeStore,
    private readonly config: ResolvedPeriscopeConfig,
    private readonly environment: DashboardEnvironment
  ) {}

  csrfToken({ request, response }: HttpContext) {
    const token = (request as typeof request & { csrfToken?: unknown }).csrfToken
    response.header('cache-control', 'no-store')

    return { token: typeof token === 'string' ? token : null }
  }

  async counts({ request }: HttpContext) {
    const application = firstQueryString(request.qs().application)
    return { data: await this.store.counts(application) }
  }

  async stats({ request, response }: HttpContext) {
    const qs = request.qs()
    const application = firstQueryString(qs.application)
    const bucketPresent = qs.bucket !== undefined
    const groupByPresent = qs.group_by !== undefined

    if (bucketPresent || groupByPresent) {
      const rawBucket = firstQueryString(qs.bucket)
      const rawGroupBy = firstQueryString(qs.group_by)
      let bucketSeconds: number | undefined
      let groupBy: 'route' | undefined

      if (bucketPresent) {
        if (
          rawBucket === undefined ||
          !/^\d+$/.test(rawBucket) ||
          Number(rawBucket) < 1 ||
          Number(rawBucket) > 604_800
        ) {
          response.badRequest({ error: 'bucket must be a whole number between 1 and 604800' })
          return
        }
        bucketSeconds = Number(rawBucket)
      }

      if (groupByPresent) {
        if (rawGroupBy !== 'route') {
          response.badRequest({ error: 'group_by must be route' })
          return
        }
        groupBy = 'route'
      }

      const rawFrom = firstQueryString(qs.from)
      const rawTo = firstQueryString(qs.to)
      const from = validIsoDateTime(rawFrom)
      const to = validIsoDateTime(rawTo)

      /*
       * Entry-list filters deliberately omit malformed dates. Analytics cannot make the same
       * tolerant choice: silently widening a requested window would produce plausible but false
       * numbers, so a present invalid bound is an API error here.
       */
      if (
        (qs.from !== undefined && from === undefined) ||
        (qs.to !== undefined && to === undefined)
      ) {
        response.badRequest({ error: 'from and to must be valid ISO datetimes' })
        return
      }

      const resolvedTo = to ?? new Date().toISOString()
      const toMs = Date.parse(resolvedTo)
      const resolvedFrom =
        from ??
        new Date(
          toMs - (bucketSeconds === undefined ? 3_600 : 60 * bucketSeconds) * 1_000
        ).toISOString()
      const fromMs = Date.parse(resolvedFrom)

      if (fromMs > toMs) {
        response.badRequest({ error: 'from must be before or equal to to' })
        return
      }

      if (bucketSeconds === undefined) {
        bucketSeconds = Math.max(1, Math.ceil((toMs - fromMs) / 1_000))
      }

      if (Math.ceil((toMs - fromMs) / (bucketSeconds * 1_000)) > 500) {
        response.badRequest({ error: 'stats windows may contain at most 500 buckets' })
        return
      }

      const result = await this.store.requestStats({
        application,
        from: resolvedFrom,
        to: resolvedTo,
        bucketSeconds,
        groupBy,
      })
      response.header('cache-control', 'no-store')

      return {
        data: {
          from: resolvedFrom,
          to: resolvedTo,
          bucketSeconds,
          groupBy: groupBy ?? null,
          buckets: result.buckets,
          sampled: result.sampled,
          truncated: result.truncated,
        },
      }
    }

    const [requestPage, slowQueryPage] = await Promise.all([
      this.store.list({
        type: 'request',
        application,
        limit: STATS_SAMPLE_SIZE,
      }),
      this.store.list({
        type: 'query',
        tag: 'slow',
        application,
        limit: STATS_SAMPLE_SIZE,
      }),
    ])
    const durations: number[] = []
    let errorCount = 0

    for (const entry of requestPage.data) {
      const status = entry.content.status
      if (typeof status === 'number' && Number.isFinite(status) && status >= 500) errorCount += 1
      const duration = entry.content.durationMs
      if (typeof duration === 'number' && Number.isFinite(duration)) durations.push(duration)
    }
    durations.sort((left, right) => left - right)

    const families = new Map<string, SlowQueryFamily>()
    for (const entry of slowQueryPage.data) {
      if (entry.familyHash === null) continue
      const sql = typeof entry.content.sql === 'string' ? entry.content.sql : ''
      const rawDuration = entry.content.durationMs
      const duration =
        typeof rawDuration === 'number' && Number.isFinite(rawDuration) ? rawDuration : null
      const family = families.get(entry.familyHash)

      if (family) {
        family.count += 1
        if (duration !== null) {
          family.durationTotal += duration
          family.durationCount += 1
          family.maxDurationMs = Math.max(family.maxDurationMs, duration)
        }
        if (family.sql === '' && sql !== '') family.sql = sql
        continue
      }

      families.set(entry.familyHash, {
        familyHash: entry.familyHash,
        sql,
        count: 1,
        durationTotal: duration ?? 0,
        durationCount: duration === null ? 0 : 1,
        maxDurationMs: duration ?? 0,
      })
    }

    const slowQueryFamilies = [...families.values()]
      .sort((left, right) => right.count - left.count || right.maxDurationMs - left.maxDurationMs)
      .slice(0, SLOW_QUERY_FAMILY_LIMIT)
      .map(({ durationTotal, durationCount, ...family }) => ({
        ...family,
        avgDurationMs: durationCount === 0 ? null : durationTotal / durationCount,
        maxDurationMs: durationCount === 0 ? null : family.maxDurationMs,
      }))

    response.header('cache-control', 'no-store')
    return {
      data: {
        requests: {
          sampled: requestPage.data.length,
          errorCount,
          p50: percentile(durations, 0.5),
          p95: percentile(durations, 0.95),
        },
        slowQueryFamilies,
      },
    }
  }

  async status() {
    const enabled = isRecordingEnabled(this.config, {
      nodeEnv: this.environment.nodeEnv,
      periscopeEnabled: this.environment.periscopeEnabled(),
    })
    const applications = await this.store.applications()

    if (!applications.some((application) => application.name === this.config.applicationName)) {
      applications.unshift({
        name: this.config.applicationName,
        entries: 0,
        latestAt: null,
      })
    }

    return {
      enabled,
      paused: (await this.store.getFlag(Flag.PAUSED)) !== null,
      path: this.config.dashboard.path,
      applicationName: this.config.applicationName,
      applications: applications.map((application) => ({
        ...application,
        latestAt: application.latestAt?.toISOString() ?? null,
      })),
      nPlusOneThreshold: this.config.dashboard.nPlusOneThreshold,
    }
  }

  async setFlag({ params, request, response }: HttpContext) {
    const name = params.name
    const dumpOpenLease = typeof name === 'string' && DUMP_OPEN_LEASE_FLAG_PATTERN.test(name)

    if (name !== Flag.PAUSED && !dumpOpenLease) {
      response.notFound()
      return
    }

    const value = request.input('value')
    const options = dumpOpenLease
      ? { expiresAt: new Date(Date.now() + DUMP_OPEN_TTL_MS) }
      : undefined
    await this.store.setFlag(name, value === undefined ? '1' : String(value), options)
    response.noContent()
  }

  async deleteFlag({ params, response }: HttpContext) {
    const name = params.name

    if (
      name !== Flag.PAUSED &&
      (typeof name !== 'string' || !DUMP_OPEN_LEASE_FLAG_PATTERN.test(name))
    ) {
      response.notFound()
      return
    }

    await this.store.deleteFlag(name)
    response.noContent()
  }

  async clear({ request, response }: HttpContext) {
    const application = firstQueryString(request.qs().application)
    await this.store.clear(application)
    response.noContent()
  }
}
