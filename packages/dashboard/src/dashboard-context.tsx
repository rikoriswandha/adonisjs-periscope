import { createContext, useContext } from 'react'

import type { DashboardStatus, EntryCounts, FlushStreamEvent, LiveUpdateMode } from '@/types'

export type DashboardContextValue = {
  status: DashboardStatus | null
  counts: EntryCounts
  statusError: Error | null
  mutating: boolean
  revision: number
  liveUpdateMode: LiveUpdateMode
  flushEvent: FlushStreamEvent | null
  flushRevision: number
  monitoredTags: readonly string[]
  monitoringTags: readonly string[]
  monitoredTagsReady: boolean
  togglePaused: (paused: boolean) => Promise<void>
  clearEntries: () => Promise<void>
  refreshCounts: () => Promise<void>
  toggleTagMonitoring: (tag: string) => Promise<void>
}

export const DashboardContext = createContext<DashboardContextValue | null>(null)

export function useDashboard(): DashboardContextValue {
  const value = useContext(DashboardContext)
  if (!value) throw new Error('useDashboard must be used within DashboardContext')
  return value
}
