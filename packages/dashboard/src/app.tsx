import { lazy, Suspense } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AppShell } from '@/components/app-shell'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { RegisteredEntryPage } from '@/entry-type-registry'
import { wave2EntryTypes } from '@/wave2-entry-types'

const ExceptionsPage = lazy(() =>
  import('@/pages/exceptions-page').then((module) => ({ default: module.ExceptionsPage }))
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
const SearchPage = lazy(() =>
  import('@/pages/search-page').then((module) => ({ default: module.SearchPage }))
)

const wave2Routes = wave2EntryTypes.map((registration) => ({
  registration,
  Page: lazy(async () => {
    const implementation = await registration.load()
    return {
      default: function Wave2EntryPage() {
        return <RegisteredEntryPage registration={registration} implementation={implementation} />
      },
    }
  }),
}))

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
              <Route element={<SearchPage />} path="search" />
              {wave2Routes.map(({ registration, Page }) => (
                <Route element={<Page />} key={registration.type} path={registration.path} />
              ))}
              <Route element={<Navigate replace to="/requests" />} path="*" />
            </Route>
          </Routes>
        </Suspense>
      </TooltipProvider>
    </HashRouter>
  )
}
