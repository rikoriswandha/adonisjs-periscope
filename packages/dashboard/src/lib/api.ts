import type {
  DashboardStatus,
  EntryCounts,
  EntryFilters,
  EntryPage,
  ExceptionGroupFilters,
  ExceptionGroupPage,
  StoredEntry,
} from '@/types'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

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
    appendFilter(params, 'tag', filters.tag)
    appendFilter(params, 'family_hash', filters.familyHash)
    appendFilter(params, 'batch_id', filters.batchId)
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

  getCounts(signal?: AbortSignal): Promise<EntryCounts> {
    return request<{ data: EntryCounts }>('counts', { signal }).then((response) => response.data)
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

  clear(): Promise<void> {
    return request<void>('clear', { method: 'POST' })
  },

  getExceptionGroups(
    filters: ExceptionGroupFilters = {},
    signal?: AbortSignal
  ): Promise<ExceptionGroupPage> {
    const params = new URLSearchParams()
    appendFilter(params, 'cursor', filters.cursor)
    appendFilter(params, 'limit', filters.limit ?? 50)
    appendFilter(params, 'tag', filters.tag)
    return request<ExceptionGroupPage>(`exception-groups?${params.toString()}`, {
      signal,
    })
  },
}
