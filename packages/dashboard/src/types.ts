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
  'view',
  'http_client',
  'schedule',
  'job',
  'broadcast',
  'health_check',
  'redis',
  'session',
  'validation',
  'rate_limit',
  'lock',
  'drive',
  'ally',
  'i18n',
  'notification',
  'socket',
] as const

export type EntryType = (typeof ENTRY_TYPES)[number]

export type EntryContent = Record<string, unknown>

export type StoredEntry = {
  uuid: string
  batchId: string
  application: string
  type: EntryType
  familyHash: string | null
  content: EntryContent
  tags: string[]
  shouldDisplayOnIndex: boolean
  sequence: string
  createdAt: string
}

export type EntryMetadataRecord = {
  uuid: string
  pinned: boolean
  note: string | null
  updatedAt: string | null
}

export type EntryPage = {
  data: StoredEntry[]
  nextCursor: string | null
}

export type EntryFilters = {
  type?: EntryType
  tag?: string
  tags?: string[]
  text?: string
  from?: string
  to?: string
  familyHash?: string
  batchId?: string
  application?: string
  cursor?: string
  limit?: number
  displayOnIndex?: boolean
}

export type ApplicationSummary = {
  name: string
  entries: number
  latestAt: string | null
}

export type DashboardStatus = {
  enabled: boolean
  paused: boolean
  path: string
  applicationName: string
  applications: ApplicationSummary[]
  nPlusOneThreshold: number
}

export type EntryCounts = Partial<Record<EntryType, number>>

export type FlushedIndexRow = Omit<StoredEntry, 'content' | 'shouldDisplayOnIndex'> & {
  shouldDisplayOnIndex: true
}

export type FlushStreamEvent = {
  type: EntryType
  uuid: string
  indexRow: FlushedIndexRow
}

export type LiveUpdateMode = 'connecting' | 'live' | 'polling' | 'off'
export type ExceptionGroupState = 'open' | 'resolved' | 'ignored'

export type ExceptionGroup = {
  familyHash: string
  latest: StoredEntry
  count: number
  lastSeen: string
  state: ExceptionGroupState
  stateUpdatedAt: string | null
}

export type ExceptionGroupPage = {
  data: ExceptionGroup[]
  nextCursor: string | null
}

export type ExceptionGroupFilters = {
  cursor?: string
  limit?: number
  tag?: string
  application?: string
}

export type RequestContent = EntryContent & {
  method: string
  url: string
  query: unknown
  traceId?: string
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
  inertia?: { component: string; propKeys?: string[] }
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

export type CommandContent = EntryContent & {
  command: string
  args: unknown
  flags: unknown
  isMain: boolean
  exitCode: number
  durationMs: number
  output?: string
  error?: unknown
}

export type MailLifecycle = 'sending' | 'sent' | 'queueing' | 'queued' | 'queue_error'

export type MailContent = EntryContent & {
  event: MailLifecycle
  mailer: string
  envelope?: unknown
  subject?: string
  html?: string
  text?: string
  raw?: string
  messageId?: string
  metadata?: unknown
  response?: unknown
  error?: unknown
  truncated?: boolean
}

export type CacheOperation = 'hit' | 'miss' | 'set' | 'delete' | 'clear'

export type CacheContent = EntryContent & {
  operation: CacheOperation
  store: string
  key?: string
  layer?: 'l1' | 'l2'
  graced?: boolean
  value?: unknown
}

export type ModelContent = EntryContent & {
  action: 'create' | 'update' | 'delete'
  model: string
  primaryKey?: string
  primaryKeyValue?: unknown
  attributes?: unknown
  dirty?: unknown
}

export type GateContent = EntryContent & {
  ability: string
  allowed: boolean
  userId?: string | number
  user?: unknown
  args: unknown
  status?: number
  message?: string
}

export type DumpCaller = {
  file: string
  line: number
  column?: number
}

export type DumpContent = EntryContent & {
  values: unknown
  caller?: DumpCaller
}

export type HttpClientContent = EntryContent & {
  method: string
  url: string
  status?: number
  durationMs: number
  requestHeaders?: Record<string, unknown>
  responseHeaders?: Record<string, unknown>
  error?: unknown
  completed: boolean
}

export type JobContent = EntryContent & {
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

export type ScheduleContent = EntryContent & {
  adapter: string
  queue: string
  jobId: string
  name?: string
  scheduledAt?: string
  delayMs?: number
  payload?: unknown
}

export type BroadcastContent = EntryContent & {
  channel: string
  event?: string
  payloadSummary?: unknown
}

export type ViewContent = EntryContent & {
  template: string
  durationMs?: number
  dataKeys?: string[]
}

export type HealthCheckStatus = 'ok' | 'warning' | 'error' | 'unknown'

export type HealthCheckResult = {
  name: string
  status: HealthCheckStatus
  durationMs?: number
  message?: string
}

export type HealthCheckContent = EntryContent & {
  status: HealthCheckStatus
  checks: HealthCheckResult[]
}

export type RedisContent = EntryContent & {
  command: string
  argumentCount: number
  arguments?: unknown
  durationMs: number
  error?: unknown
}

export type SessionContent = EntryContent & {
  operation: 'initiated' | 'committed' | 'migrated'
  sessionIdHash: string
  fromSessionIdHash?: string
  fresh: boolean
  readonly: boolean
  modified: boolean
  values?: unknown
}
