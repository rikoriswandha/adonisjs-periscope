export type JobEntryContent = Record<string, unknown> & {
  adapter: string
  queue: string
  jobId: string
  name?: string
  status: 'completed' | 'failed'
  durationMs?: number
  attempts?: number
  payload?: unknown
  result?: unknown
  error?: unknown
}

export type ScheduleEntryContent = Record<string, unknown> & {
  adapter: string
  queue: string
  jobId: string
  name?: string
  scheduledAt?: string
  delayMs?: number
  payload?: unknown
}
