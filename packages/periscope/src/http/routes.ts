/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { Router } from '@adonisjs/core/http'

import type { Recorder } from '../recorder/recorder.ts'
import type { ResolvedPeriscopeConfig } from '../types.ts'
import { DashboardController } from './controllers/dashboard_controller.ts'
import { EntriesController } from './controllers/entries_controller.ts'
import { ExceptionGroupsController } from './controllers/exception_groups_controller.ts'
import { MonitoredTagsController } from './controllers/monitored_tags_controller.ts'
import { StaticController } from './controllers/static_controller.ts'
import { StreamController } from './controllers/stream_controller.ts'
import { createDashboardAuthorize } from './middleware/authorize.ts'
import type { DashboardEnvironment } from './middleware/authorize.ts'

export type RegisterDashboardRoutesOptions = {
  router: Router
  recorder: Recorder
  config: ResolvedPeriscopeConfig
  environment: DashboardEnvironment
  dashboardRoot?: string
}

/**
 * Register the complete dashboard surface before the router is committed. API catch-alls precede
 * the SPA fallback so a misspelled endpoint is always a 404 rather than an HTML document.
 */
export function registerDashboardRoutes(options: RegisterDashboardRoutesOptions): void {
  const { router, recorder, config, environment } = options
  const entries = new EntriesController(recorder.store)
  const dashboard = new DashboardController(recorder.store, config, environment)
  const exceptionGroups = new ExceptionGroupsController(recorder.store)
  const monitoredTags = new MonitoredTagsController(recorder.store)
  const stream = new StreamController(recorder)
  const staticFiles = new StaticController({
    dashboardPath: config.dashboard.path,
    dashboardRoot: options.dashboardRoot,
  })
  const authorize = createDashboardAuthorize(config, recorder, environment)

  const routes = router.group(() => {
    router.get('/api/entries', entries.index.bind(entries))
    router.get('/api/entries/:uuid', entries.show.bind(entries))
    router.get('/api/entries/:uuid/eml', entries.eml.bind(entries))
    router.get('/api/batches/:batchId', entries.batch.bind(entries))
    router.get('/api/batches/:batchId/export', entries.exportBatch.bind(entries))
    router.get('/api/counts', dashboard.counts.bind(dashboard))
    router.get('/api/status', dashboard.status.bind(dashboard))
    router.put('/api/flags/:name', dashboard.setFlag.bind(dashboard))
    router.delete('/api/flags/:name', dashboard.deleteFlag.bind(dashboard))
    router.post('/api/clear', dashboard.clear.bind(dashboard))
    router.get('/api/exception-groups', exceptionGroups.index.bind(exceptionGroups))
    router.route('/api/stream', ['GET'], stream.stream.bind(stream))
    router.get('/api/monitored-tags', monitoredTags.index.bind(monitoredTags))
    router.put('/api/monitored-tags/:tag', monitoredTags.set.bind(monitoredTags))
    router.delete('/api/monitored-tags/:tag', monitoredTags.delete.bind(monitoredTags))

    router.any('/api', ({ response }) => response.notFound())
    router.any('/api/*', ({ response }) => response.notFound())

    router.get('/assets/*', staticFiles.asset.bind(staticFiles))
    router.get('/', staticFiles.root.bind(staticFiles))
    router.get('*', staticFiles.spa.bind(staticFiles))
  })

  if (config.dashboard.path !== '/') {
    routes.prefix(config.dashboard.path)
  }

  routes.use(authorize)
}
