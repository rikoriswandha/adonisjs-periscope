import { ENTRY_TYPES } from '../types.ts'
import { randomUUID } from './random-uuid.ts'
import type { EntryFilters, FlushStreamEvent, LiveUpdateMode } from '../types.ts'

const entryTypeLookup: Record<string, true> = Object.fromEntries(
  ENTRY_TYPES.map((type) => [type, true] as const)
)

export function parseFlushStreamEvent(data: string): FlushStreamEvent | null {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }

  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  const indexRow = event.indexRow
  if (
    typeof event.type !== 'string' ||
    !entryTypeLookup[event.type] ||
    typeof event.uuid !== 'string' ||
    event.uuid.length === 0 ||
    !indexRow ||
    typeof indexRow !== 'object'
  ) {
    return null
  }

  const row = indexRow as Record<string, unknown>
  if (
    row.type !== event.type ||
    row.uuid !== event.uuid ||
    typeof row.batchId !== 'string' ||
    typeof row.application !== 'string' ||
    !(row.familyHash === null || typeof row.familyHash === 'string') ||
    !Array.isArray(row.tags) ||
    !row.tags.every((tag) => typeof tag === 'string') ||
    row.shouldDisplayOnIndex !== true ||
    typeof row.sequence !== 'string' ||
    typeof row.createdAt !== 'string'
  ) {
    return null
  }

  return value as FlushStreamEvent
}

export function streamEventMatchesFilters(event: FlushStreamEvent, filters: EntryFilters): boolean {
  const row = event.indexRow
  return (
    (!filters.type || filters.type === row.type) &&
    (!filters.tag || row.tags.includes(filters.tag)) &&
    (!filters.familyHash || filters.familyHash === row.familyHash) &&
    (!filters.batchId || filters.batchId === row.batchId) &&
    (!filters.application || filters.application === row.application) &&
    (filters.displayOnIndex !== true || row.shouldDisplayOnIndex)
  )
}

export function shouldPollForUpdates(mode: LiveUpdateMode, paused: boolean): boolean {
  return !paused && mode !== 'live'
}

export function liveUpdateLabel(mode: LiveUpdateMode, recordingEnabled: boolean): string {
  if (!recordingEnabled) return 'Recording offline'
  switch (mode) {
    case 'live':
      return 'Live updates'
    case 'polling':
      return 'Polling fallback'
    case 'connecting':
      return 'Connecting live'
    case 'off':
      return 'Updates paused'
  }
}

export type LiveUpdateTimer = number | NodeJS.Timeout

export type CoalescedCallback = {
  schedule(): void
  cancel(): void
}

export function createCoalescedCallback(
  callback: () => void,
  options: {
    delay?: number
    maxWait?: number
    setTimer?: (callback: () => void, delay: number) => LiveUpdateTimer
    clearTimer?: (timer: LiveUpdateTimer) => void
  } = {}
): CoalescedCallback {
  const delay = options.delay ?? 300
  const maxWait = options.maxWait ?? 2_000
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  let trailingTimer: LiveUpdateTimer | undefined
  let maxTimer: LiveUpdateTimer | undefined

  const cancel = () => {
    if (trailingTimer !== undefined) clearTimer(trailingTimer)
    if (maxTimer !== undefined) clearTimer(maxTimer)
    trailingTimer = undefined
    maxTimer = undefined
  }
  const invoke = () => {
    cancel()
    callback()
  }

  return {
    schedule() {
      if (trailingTimer !== undefined) clearTimer(trailingTimer)
      trailingTimer = setTimer(invoke, delay)
      maxTimer ??= setTimer(invoke, maxWait)
    },
    cancel,
  }
}

type EventSourceLike = {
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

type BroadcastChannelLike = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: unknown): void
  close(): void
}

type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

type LiveUpdateMessage =
  | { type: 'flush'; event: FlushStreamEvent }
  | {
      type: 'heartbeat'
      leaderId: string
      scope: string
      mode: LiveUpdateMode
    }

type LeaderLease = {
  leaderId: string
  expiresAt: number
}

export type LiveUpdateConnection = {
  close(): void
}

export type LiveUpdateConnectionOptions = {
  url: string
  onFlush: (event: FlushStreamEvent) => void
  onModeChange: (mode: LiveUpdateMode) => void
  eventSourceFactory?: (url: string) => EventSourceLike
  broadcastChannelFactory?: ((name: string) => BroadcastChannelLike) | null
  storage?: StorageLike | null
  now?: () => number
  createId?: () => string
  setTimer?: (callback: () => void, delay: number) => LiveUpdateTimer
  clearTimer?: (timer: LiveUpdateTimer) => void
  setRepeatingTimer?: (callback: () => void, delay: number) => LiveUpdateTimer
  clearRepeatingTimer?: (timer: LiveUpdateTimer) => void
}

const CHANNEL_NAME = 'periscope-sse'
const HEARTBEAT_INTERVAL = 5_000
const LEADER_TIMEOUT = 12_000

/**
 * Keeps one stream per application scope across tabs. The expiring localStorage lease is
 * deliberately best-effort: a racing election can briefly duplicate a stream, while the next
 * heartbeat converges every follower on the lease winner without risking missed updates.
 */
export function connectLiveUpdates(options: LiveUpdateConnectionOptions): LiveUpdateConnection {
  const eventSourceFactory =
    options.eventSourceFactory ??
    (typeof EventSource === 'undefined' ? undefined : (url: string) => new EventSource(url))
  if (!eventSourceFactory) {
    options.onModeChange('polling')
    return { close() {} }
  }

  const broadcastChannelFactory =
    options.broadcastChannelFactory === undefined
      ? typeof BroadcastChannel === 'undefined'
        ? null
        : (name: string) => new BroadcastChannel(name)
      : options.broadcastChannelFactory
  let storage = options.storage
  if (storage === undefined) {
    try {
      storage = typeof localStorage === 'undefined' ? null : localStorage
    } catch {
      storage = null
    }
  }

  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const setRepeatingTimer = options.setRepeatingTimer ?? setInterval
  const clearRepeatingTimer = options.clearRepeatingTimer ?? clearInterval
  const leaderId = options.createId?.() ?? randomUUID()
  const leaseKey = `periscope-sse-leader:${options.url}`
  let source: EventSourceLike | null = null
  let channel: BroadcastChannelLike | null = null
  let failoverTimer: LiveUpdateTimer | undefined
  let heartbeatTimer: LiveUpdateTimer | undefined
  let closed = false
  let mode: LiveUpdateMode = 'connecting'

  const changeMode = (next: LiveUpdateMode) => {
    mode = next
    options.onModeChange(next)
  }
  const parseLease = (): LeaderLease | null => {
    try {
      const value = storage?.getItem(leaseKey)
      if (!value) return null
      const lease = JSON.parse(value) as Partial<LeaderLease>
      return typeof lease.leaderId === 'string' && typeof lease.expiresAt === 'number'
        ? (lease as LeaderLease)
        : null
    } catch {
      return null
    }
  }
  const releaseLease = () => {
    try {
      if (parseLease()?.leaderId === leaderId) storage?.removeItem(leaseKey)
    } catch {
      // A closing tab does not need persistence in order to release its in-memory resources.
    }
  }
  const stopLeader = () => {
    if (heartbeatTimer !== undefined) clearRepeatingTimer(heartbeatTimer)
    heartbeatTimer = undefined
    if (source) {
      source.close()
      source = null
    }
  }
  const postHeartbeat = () => {
    if (!channel || !storage || closed) return
    try {
      storage.setItem(leaseKey, JSON.stringify({ leaderId, expiresAt: now() + LEADER_TIMEOUT }))
    } catch {
      return
    }
    channel.postMessage({ type: 'heartbeat', leaderId, scope: options.url, mode })
  }
  const receiveFlush = (event: Event) => {
    const parsed = parseFlushStreamEvent((event as MessageEvent<string>).data)
    if (!parsed) return
    options.onFlush(parsed)
    channel?.postMessage({ type: 'flush', event: parsed } satisfies LiveUpdateMessage)
  }
  const becomeLeader = () => {
    if (closed || source) return
    if (failoverTimer !== undefined) clearTimer(failoverTimer)
    failoverTimer = undefined
    changeMode('connecting')
    source = eventSourceFactory(options.url)
    source.onopen = () => {
      changeMode('live')
      postHeartbeat()
    }
    source.onerror = () => {
      changeMode('polling')
      postHeartbeat()
    }
    source.addEventListener('flush', receiveFlush)
    postHeartbeat()
    heartbeatTimer = setRepeatingTimer(postHeartbeat, HEARTBEAT_INTERVAL)
  }
  const scheduleElection = (delay = LEADER_TIMEOUT) => {
    if (failoverTimer !== undefined) clearTimer(failoverTimer)
    failoverTimer = setTimer(elect, Math.max(0, delay))
  }
  function elect() {
    if (closed || !storage) return
    const lease = parseLease()
    if (lease && lease.leaderId !== leaderId && lease.expiresAt > now()) {
      scheduleElection(lease.expiresAt - now())
      return
    }
    try {
      storage.setItem(leaseKey, JSON.stringify({ leaderId, expiresAt: now() + LEADER_TIMEOUT }))
    } catch {
      startPerTabStream()
      return
    }
    if (parseLease()?.leaderId === leaderId) becomeLeader()
    else scheduleElection()
  }
  const startPerTabStream = () => {
    if (closed || source) return
    changeMode('connecting')
    source = eventSourceFactory(options.url)
    source.onopen = () => changeMode('live')
    source.onerror = () => changeMode('polling')
    source.addEventListener('flush', receiveFlush)
  }

  changeMode('connecting')
  if (!broadcastChannelFactory || !storage) {
    startPerTabStream()
  } else {
    channel = broadcastChannelFactory(CHANNEL_NAME)
    channel.onmessage = (message) => {
      if (closed || !message.data || typeof message.data !== 'object') return
      const data = message.data as Partial<LiveUpdateMessage>
      if (data.type === 'flush' && data.event) {
        const parsed = parseFlushStreamEvent(JSON.stringify(data.event))
        if (parsed) options.onFlush(parsed)
        return
      }
      if (
        data.type !== 'heartbeat' ||
        data.scope !== options.url ||
        data.leaderId === leaderId ||
        typeof data.mode !== 'string'
      ) {
        return
      }
      const lease = parseLease()
      if (source && lease?.leaderId !== leaderId) stopLeader()
      changeMode(data.mode)
      scheduleElection()
    }
    elect()
  }

  return {
    close() {
      if (closed) return
      closed = true
      if (failoverTimer !== undefined) clearTimer(failoverTimer)
      stopLeader()
      releaseLease()
      if (channel) {
        channel.onmessage = null
        channel.close()
      }
    },
  }
}
