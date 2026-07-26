import { lazy, Suspense } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AppShell } from '@/components/app-shell'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'

const CachePage = lazy(() =>
  import('@/pages/cache-page').then((module) => ({ default: module.CachePage }))
)
const CommandsPage = lazy(() =>
  import('@/pages/commands-page').then((module) => ({ default: module.CommandsPage }))
)
const DumpsPage = lazy(() =>
  import('@/pages/dumps-page').then((module) => ({ default: module.DumpsPage }))
)
const ExceptionsPage = lazy(() =>
  import('@/pages/exceptions-page').then((module) => ({ default: module.ExceptionsPage }))
)
const GatesPage = lazy(() =>
  import('@/pages/gates-page').then((module) => ({ default: module.GatesPage }))
)
const HttpClientPage = lazy(() =>
  import('@/pages/http-client-page').then((module) => ({ default: module.HttpClientPage }))
)
const MailPage = lazy(() =>
  import('@/pages/mail-page').then((module) => ({ default: module.MailPage }))
)
const ModelsPage = lazy(() =>
  import('@/pages/models-page').then((module) => ({ default: module.ModelsPage }))
)
const QueriesPage = lazy(() =>
  import('@/pages/queries-page').then((module) => ({ default: module.QueriesPage }))
)
const RequestBatchPage = lazy(() =>
  import('@/pages/request-batch-page').then((module) => ({ default: module.RequestBatchPage }))
)
const RequestsPage = lazy(() =>
  import('@/pages/requests-page').then((module) => ({ default: module.RequestsPage }))
)

export function App() {
  return (
    <HashRouter>
      <TooltipProvider>
        <Suspense
          fallback={
            <div className="grid gap-3" role="status" aria-label="Loading dashboard">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-72 w-full" />
            </div>
          }
        >
          <Routes>
            <Route element={<AppShell />}>
              <Route element={<Navigate replace to="/requests" />} index />
              <Route element={<RequestsPage />} path="requests" />
              <Route element={<RequestBatchPage />} path="requests/:batchId" />
              <Route element={<QueriesPage />} path="queries" />
              <Route element={<ExceptionsPage />} path="exceptions" />
              <Route element={<CommandsPage />} path="commands" />
              <Route element={<MailPage />} path="mail" />
              <Route element={<CachePage />} path="cache" />
              <Route element={<ModelsPage />} path="models" />
              <Route element={<GatesPage />} path="gates" />
              <Route element={<DumpsPage />} path="dumps" />
              <Route element={<HttpClientPage />} path="http-client" />
              <Route element={<Navigate replace to="/requests" />} path="*" />
            </Route>
          </Routes>
        </Suspense>
      </TooltipProvider>
    </HashRouter>
  )
}
