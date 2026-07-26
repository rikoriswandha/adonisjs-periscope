export const ENTRY_TYPES = [
  'request',
  'query',
  'exception',
  'log',
  'event',
  'command',
  'mail',
  'cache',
  'model',
  'gate',
  'dump',
  'http_client',
  'schedule',
  'job',
  'notification',
  'redis',
  'session',
] as const

export type EntryType = (typeof ENTRY_TYPES)[number]

export type EntryContent = Record<string, unknown>

export type StoredEntry = {
  uuid: string
  batchId: string
  type: EntryType
  familyHash: string | null
  content: EntryContent
  tags: string[]
  shouldDisplayOnIndex: boolean
  sequence: string
  createdAt: string
}

export type EntryPage = {
  data: StoredEntry[]
  nextCursor: string | null
}

export type EntryFilters = {
  type?: EntryType
  tag?: string
  familyHash?: string
  batchId?: string
  cursor?: string
  limit?: number
  displayOnIndex?: boolean
}

export type DashboardStatus = {
  enabled: boolean
  paused: boolean
  path: string
  nPlusOneThreshold: number
}

export type EntryCounts = Partial<Record<EntryType, number>>

export type ExceptionGroup = {
  familyHash: string
  latest: StoredEntry
  count: number
  lastSeen: string
}

export type ExceptionGroupPage = {
  data: ExceptionGroup[]
  nextCursor: string | null
}

export type ExceptionGroupFilters = {
  cursor?: string
  limit?: number
  tag?: string
}

export type RequestContent = EntryContent & {
  method: string
  url: string
  query: unknown
  routePattern?: string
  routeName?: string
  headers: Record<string, unknown>
  payload: unknown
  status: number | null
  durationMs: number
  user?: { id: string | number; email?: string }
  memoryDeltaBytes: number
  ip: string
  hostname: string | null
  response?: unknown
  session?: unknown
  clientDisconnected: boolean
}

export type QueryContent = EntryContent & {
  sql: string
  bindings: unknown
  connection: string
  model?: string
  method: string
  durationMs?: number
  inTransaction?: boolean
  ddl?: boolean
  error?: { name: string; message: string }
}

export type ExceptionStackFrame = {
  file: string
  line: number | null
  column: number | null
  function: string | null
  type: 'app' | 'module' | 'native'
  raw: string
}

export type ExceptionCodeFrameLine = {
  line: number
  source: string
  highlight: boolean
}

export type ExceptionContent = EntryContent & {
  name: string
  message: string
  code?: string
  status?: number
  stack: string
  frames: ExceptionStackFrame[]
  codeFrame?: ExceptionCodeFrameLine[]
  request?: {
    method: string
    url: string
    route?: { pattern: string; name?: string }
  }
  context?: unknown
}
