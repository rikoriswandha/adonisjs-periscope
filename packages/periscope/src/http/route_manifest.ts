/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

type DashboardRouteManifestRow = {
  id: string
  pattern: string
  methods: readonly string[]
}

/**
 * The dashboard's complete route surface in registration order. The API catch-alls must remain
 * ahead of the SPA fallback: route order is part of the public registration contract, not merely
 * presentation for the doctor hook.
 */
export const DASHBOARD_ROUTE_MANIFEST = [
  { id: 'entriesIndex', pattern: '/api/entries', methods: ['GET', 'HEAD'] },
  { id: 'entriesShow', pattern: '/api/entries/:uuid', methods: ['GET', 'HEAD'] },
  { id: 'entriesEml', pattern: '/api/entries/:uuid/eml', methods: ['GET', 'HEAD'] },
  { id: 'entriesBatch', pattern: '/api/batches/:batchId', methods: ['GET', 'HEAD'] },
  {
    id: 'entriesExportBatch',
    pattern: '/api/batches/:batchId/export',
    methods: ['GET', 'HEAD'],
  },
  { id: 'dashboardCsrfToken', pattern: '/api/csrf-token', methods: ['GET', 'HEAD'] },
  { id: 'dashboardCounts', pattern: '/api/counts', methods: ['GET', 'HEAD'] },
  { id: 'dashboardStats', pattern: '/api/stats', methods: ['GET', 'HEAD'] },
  { id: 'dashboardStatus', pattern: '/api/status', methods: ['GET', 'HEAD'] },
  { id: 'dashboardSetFlag', pattern: '/api/flags/:name', methods: ['PUT'] },
  { id: 'dashboardDeleteFlag', pattern: '/api/flags/:name', methods: ['DELETE'] },
  { id: 'dashboardClear', pattern: '/api/clear', methods: ['POST'] },
  { id: 'exceptionGroupsIndex', pattern: '/api/exception-groups', methods: ['GET', 'HEAD'] },
  { id: 'stream', pattern: '/api/stream', methods: ['GET'] },
  { id: 'monitoredTagsIndex', pattern: '/api/monitored-tags', methods: ['GET', 'HEAD'] },
  { id: 'monitoredTagsSet', pattern: '/api/monitored-tags/:tag', methods: ['PUT'] },
  { id: 'monitoredTagsDelete', pattern: '/api/monitored-tags/:tag', methods: ['DELETE'] },
  {
    id: 'apiNotFound',
    pattern: '/api',
    methods: ['HEAD', 'OPTIONS', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  },
  {
    id: 'apiWildcardNotFound',
    pattern: '/api/*',
    methods: ['HEAD', 'OPTIONS', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  },
  { id: 'staticAsset', pattern: '/assets/*', methods: ['GET', 'HEAD'] },
  { id: 'staticRoot', pattern: '/', methods: ['GET', 'HEAD'] },
  { id: 'staticSpa', pattern: '*', methods: ['GET', 'HEAD'] },
] as const satisfies readonly DashboardRouteManifestRow[]

export type DashboardRouteId = (typeof DASHBOARD_ROUTE_MANIFEST)[number]['id']
