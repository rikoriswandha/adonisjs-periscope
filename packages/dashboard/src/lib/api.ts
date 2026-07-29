import type {
  DashboardStatus,
  EntryCounts,
  EntryFilters,
  EntryPage,
  ExceptionGroupFilters,
  ExceptionGroupPage,
  StoredEntry,
} from '@/types'

export type DashboardStats = {
  requests: {
    sampled: number
    errorCount: number
    p50: number | null
    p95: number | null
  }
  slowQueryFamilies: Array<{
    familyHash: string
    sql: string
    count: number
    avgDurationMs: number | null
    maxDurationMs: number | null
  }>
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const MUTATING_METHODS: Record<string, true> = {
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
}
const PERISCOPE_REQUEST_HEADER = 'x-periscope-request'
const PERISCOPE_REQUEST_HEADER_VALUE = 'dashboard'

let csrfTokenPromise: Promise<string | null> | undefined

function endpoint(path: string): URL {
  const pageUrl = new URL(window.location.href)
  pageUrl.hash = ''
  if (!pageUrl.pathname.endsWith('/')) pageUrl.pathname += '/'
  return new URL(`api/${path.replace(/^\//, '')}`, pageUrl)
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const method = (options.method ?? 'GET').toUpperCase()
  if (MUTATING_METHODS[method] === true) {
    headers.set(PERISCOPE_REQUEST_HEADER, PERISCOPE_REQUEST_HEADER_VALUE)
    const token = await csrfToken()
    if (token !== null) headers.set('x-csrf-token', token)
  }

  const response = await fetch(endpoint(path), {
    ...options,
    credentials: 'same-origin',
    headers,
  })

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`
    try {
      const body = (await response.json()) as { message?: unknown; error?: unknown }
      if (typeof body.message === 'string') message = body.message
      else if (typeof body.error === 'string') message = body.error
    } catch {
      // The status remains the useful fallback for non-JSON responses.
    }
    throw new ApiError(message, response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function csrfToken(): Promise<string | null> {
  if (csrfTokenPromise === undefined) {
    csrfTokenPromise = request<{ token: string | null }>('csrf-token')
      .then(({ token }) => token)
      .catch((cause) => {
        csrfTokenPromise = undefined
        throw cause
      })
  }

  return csrfTokenPromise
}

function appendFilter(
  params: URLSearchParams,
  key: string,
  value: string | number | boolean | undefined
) {
  if (value !== undefined && value !== '') params.set(key, String(value))
}

export const api = {
  listEntries(filters: EntryFilters, signal?: AbortSignal): Promise<EntryPage> {
    const params = new URLSearchParams()
    appendFilter(params, 'type', filters.type)
    appendFilter(params, 'text', filters.text)
    appendFilter(params, 'from', filters.from)
    appendFilter(params, 'to', filters.to)
    const tags = new Set<string>(filters.tags)
    if (filters.tag) tags.add(filters.tag)
    for (const tag of tags) params.append('tag', tag)
    appendFilter(params, 'family_hash', filters.familyHash)
    appendFilter(params, 'batch_id', filters.batchId)
    appendFilter(params, 'application', filters.application)
    appendFilter(params, 'cursor', filters.cursor)
    appendFilter(params, 'limit', filters.limit)
    appendFilter(params, 'display_on_index', filters.displayOnIndex)
    return request<EntryPage>(`entries?${params.toString()}`, { signal })
  },

  getEntry(uuid: string, signal?: AbortSignal): Promise<StoredEntry> {
    return request<{ data: StoredEntry }>(`entries/${encodeURIComponent(uuid)}`, {
      signal,
    }).then((response) => response.data)
  },

  getEntryEmlUrl(uuid: string): string {
    return endpoint(`entries/${encodeURIComponent(uuid)}/eml`).toString()
  },

  getBatch(batchId: string, signal?: AbortSignal): Promise<StoredEntry[]> {
    return request<{ data: StoredEntry[] }>(`batches/${encodeURIComponent(batchId)}`, {
      signal,
    }).then((response) => response.data)
  },

  getBatchExportUrl(batchId: string): string {
    return endpoint(`batches/${encodeURIComponent(batchId)}/export`).toString()
  },

  getCounts(application?: string, signal?: AbortSignal): Promise<EntryCounts> {
    const params = new URLSearchParams()
    appendFilter(params, 'application', application)
    return request<{ data: EntryCounts }>(`counts?${params.toString()}`, { signal }).then(
      (response) => response.data
    )
  },

  getStats(application?: string, signal?: AbortSignal): Promise<DashboardStats> {
    const params = new URLSearchParams()
    appendFilter(params, 'application', application)
    return request<{ data: DashboardStats }>(`stats?${params.toString()}`, { signal }).then(
      (response) => response.data
    )
  },

  getStatus(signal?: AbortSignal): Promise<DashboardStatus> {
    return request<DashboardStatus>('status', { signal })
  },

  getStreamUrl(): string {
    return endpoint('stream').toString()
  },

  getMonitoredTags(signal?: AbortSignal): Promise<string[]> {
    return request<{ data: string[] }>('monitored-tags', { signal }).then(
      (response) => response.data
    )
  },

  monitorTag(tag: string): Promise<void> {
    return request<void>(`monitored-tags/${encodeURIComponent(tag)}`, { method: 'PUT' })
  },

  unmonitorTag(tag: string): Promise<void> {
    return request<void>(`monitored-tags/${encodeURIComponent(tag)}`, { method: 'DELETE' })
  },

  setFlag(name: string, value = 1): Promise<void> {
    return request<void>(`flags/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    })
  },

  deleteFlag(name: string, options: Pick<RequestInit, 'keepalive'> = {}): Promise<void> {
    return request<void>(`flags/${encodeURIComponent(name)}`, {
      ...options,
      method: 'DELETE',
    })
  },

  clear(application?: string): Promise<void> {
    const params = new URLSearchParams()
    appendFilter(params, 'application', application)
    return request<void>(`clear?${params.toString()}`, { method: 'POST' })
  },

  getExceptionGroups(
    filters: ExceptionGroupFilters = {},
    signal?: AbortSignal
  ): Promise<ExceptionGroupPage> {
    const params = new URLSearchParams()
    appendFilter(params, 'cursor', filters.cursor)
    appendFilter(params, 'limit', filters.limit ?? 50)
    appendFilter(params, 'tag', filters.tag)
    appendFilter(params, 'application', filters.application)
    return request<ExceptionGroupPage>(`exception-groups?${params.toString()}`, {
      signal,
    })
  },
}
