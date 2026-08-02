/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext, Router } from '@adonisjs/core/http'

import { createInProcessFanout } from '../fanout.ts'
import type { Recorder } from '../recorder/recorder.ts'
import type { FlushFanout, ResolvedPeriscopeConfig } from '../types.ts'
import { DashboardController } from './controllers/dashboard_controller.ts'
import { EntriesController } from './controllers/entries_controller.ts'
import { EntryMetadataController } from './controllers/entry_metadata_controller.ts'
import { ExceptionGroupsController } from './controllers/exception_groups_controller.ts'
import { MonitoredTagsController } from './controllers/monitored_tags_controller.ts'
import { StaticController } from './controllers/static_controller.ts'
import { StreamController } from './controllers/stream_controller.ts'
import { createDashboardAuthorize } from './middleware/authorize.ts'
import type { DashboardEnvironment } from './middleware/authorize.ts'
import { protectDashboardMutation } from './middleware/protect_mutations.ts'
import { DASHBOARD_ROUTE_MANIFEST } from './route_manifest.ts'
import type { DashboardRouteId } from './route_manifest.ts'

export type RegisterDashboardRoutesOptions = {
  router: Router
  recorder: Recorder
  config: ResolvedPeriscopeConfig
  fanout?: FlushFanout
  environment: DashboardEnvironment
  dashboardRoot?: string
}

/**
 * Register the complete dashboard surface before the router is committed. API catch-alls precede
 * the SPA fallback so a misspelled endpoint is always a 404 rather than an HTML document.
 */
export function registerDashboardRoutes(options: RegisterDashboardRoutesOptions): void {
  const { router, recorder, config, environment } = options
  const fanout = options.fanout ?? createInProcessFanout()
  if (options.fanout === undefined) {
    recorder.subscribeFlushed((event) => void fanout.publish(event))
  }
  const entries = new EntriesController(recorder.store)
  const entryMetadata = new EntryMetadataController(recorder.store, config)
  const dashboard = new DashboardController(recorder.store, config, environment)
  const exceptionGroups = new ExceptionGroupsController(recorder.store, config.applicationName)
  const monitoredTags = new MonitoredTagsController(recorder.store, config.applicationName)
  const stream = new StreamController(
    { fanout, store: recorder.store },
    { maxClients: config.dashboard.sseMaxClients }
  )
  const staticFiles = new StaticController({
    dashboardPath: config.dashboard.path,
    dashboardRoot: options.dashboardRoot,
  })
  const authorize = createDashboardAuthorize(config, recorder, environment)

  const handlers: Record<DashboardRouteId, (context: HttpContext) => unknown> = {
    entriesIndex: entries.index.bind(entries),
    entriesShow: entries.show.bind(entries),
    entriesEml: entries.eml.bind(entries),
    entriesBatch: entries.batch.bind(entries),
    entriesExportBatch: entries.exportBatch.bind(entries),
    entriesSetMetadata: entryMetadata.set.bind(entryMetadata),
    entryMetadataIndex: entryMetadata.index.bind(entryMetadata),
    dashboardCsrfToken: dashboard.csrfToken.bind(dashboard),
    dashboardCounts: dashboard.counts.bind(dashboard),
    dashboardStats: dashboard.stats.bind(dashboard),
    dashboardStatus: dashboard.status.bind(dashboard),
    dashboardSetFlag: dashboard.setFlag.bind(dashboard),
    dashboardDeleteFlag: dashboard.deleteFlag.bind(dashboard),
    dashboardClear: dashboard.clear.bind(dashboard),
    exceptionGroupsIndex: exceptionGroups.index.bind(exceptionGroups),
    exceptionGroupsSetState: exceptionGroups.setState.bind(exceptionGroups),
    stream: stream.stream.bind(stream),
    monitoredTagsIndex: monitoredTags.index.bind(monitoredTags),
    monitoredTagsSet: monitoredTags.set.bind(monitoredTags),
    monitoredTagsDelete: monitoredTags.delete.bind(monitoredTags),
    apiNotFound: ({ response }) => response.notFound(),
    apiWildcardNotFound: ({ response }) => response.notFound(),
    staticAsset: staticFiles.asset.bind(staticFiles),
    staticRoot: staticFiles.root.bind(staticFiles),
    staticSpa: staticFiles.spa.bind(staticFiles),
  }

  const routes = router.group(() => {
    for (const route of DASHBOARD_ROUTE_MANIFEST) {
      router.route(route.pattern, [...route.methods], handlers[route.id])
    }
  })

  if (config.dashboard.path !== '/') {
    routes.prefix(config.dashboard.path)
  }

  routes.use(authorize)
  routes.use(protectDashboardMutation)
}
