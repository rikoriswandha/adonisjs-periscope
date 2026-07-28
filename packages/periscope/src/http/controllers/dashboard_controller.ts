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
import { firstQueryString } from '../query.ts'

const DUMP_OPEN_LEASE_FLAG_PATTERN = /^dump-open:[A-Za-z0-9_-]{1,128}$/
const DUMP_OPEN_TTL_MS = 30_000

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
