import assert from 'node:assert/strict'
import test from 'node:test'

import {
  connectLiveUpdates,
  createCoalescedCallback,
  liveUpdateLabel,
  parseFlushStreamEvent,
  shouldPollForUpdates,
  streamEventMatchesFilters,
} from './live-updates.ts'

const validEvent = {
  type: 'query',
  uuid: 'entry-1',
  indexRow: {
    uuid: 'entry-1',
    batchId: 'batch-1',
    application: 'default',
    type: 'query',
    familyHash: 'family-1',
    tags: ['Auth:42', 'slow'],
    shouldDisplayOnIndex: true,
    sequence: '12',
    createdAt: '2026-07-27T12:00:00.000Z',
  },
}

test('accepts a flush event carrying the complete index-row contract', () => {
  assert.deepEqual(parseFlushStreamEvent(JSON.stringify(validEvent)), validEvent)
})

test('rejects malformed, mismatched, and non-index flush events without throwing', () => {
  assert.equal(parseFlushStreamEvent('{not json'), null)
  assert.equal(
    parseFlushStreamEvent(JSON.stringify({ ...validEvent, uuid: 'different-entry' })),
    null
  )
  assert.equal(
    parseFlushStreamEvent(
      JSON.stringify({
        ...validEvent,
        indexRow: { ...validEvent.indexRow, shouldDisplayOnIndex: false },
      })
    ),
    null
  )
})

test('matches streamed rows against the active exact filters before refreshing', () => {
  const parsed = parseFlushStreamEvent(JSON.stringify(validEvent))
  assert.ok(parsed)
  assert.equal(
    streamEventMatchesFilters(parsed, { type: 'query', tag: 'Auth:42', displayOnIndex: true }),
    true
  )
  assert.equal(streamEventMatchesFilters(parsed, { type: 'query', tag: 'auth:42' }), false)
  assert.equal(streamEventMatchesFilters(parsed, { type: 'request', tag: 'Auth:42' }), false)
})

test('polls while connecting or degraded, but never beside a healthy live stream', () => {
  assert.equal(shouldPollForUpdates('connecting', false), true)
  assert.equal(shouldPollForUpdates('polling', false), true)
  assert.equal(shouldPollForUpdates('live', false), false)
  assert.equal(shouldPollForUpdates('polling', true), false)
})

test('exposes distinct accessible labels for live and polling fallback modes', () => {
  assert.equal(liveUpdateLabel('live', true), 'Live updates')
  assert.equal(liveUpdateLabel('polling', true), 'Polling fallback')
  assert.equal(liveUpdateLabel('connecting', true), 'Connecting live')
  assert.equal(liveUpdateLabel('off', true), 'Updates paused')
  assert.equal(liveUpdateLabel('off', false), 'Recording offline')
})

class FakeClock {
  now = 0
  #nextId = 1
  #tasks = new Map<number, { at: number; callback: () => void; interval?: number }>()

  setTimeout = (callback: () => void, delay: number) => {
    const id = this.#nextId++
    this.#tasks.set(id, { at: this.now + delay, callback })
    return id
  }

  setInterval = (callback: () => void, delay: number) => {
    const id = this.#nextId++
    this.#tasks.set(id, { at: this.now + delay, callback, interval: delay })
    return id
  }

  clear = (id: number | NodeJS.Timeout) => {
    this.#tasks.delete(id as number)
  }

  advance(milliseconds: number) {
    const target = this.now + milliseconds
    while (true) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next) break
      const [id, task] = next
      this.now = task.at
      if (task.interval === undefined) this.#tasks.delete(id)
      else this.#tasks.set(id, { ...task, at: task.at + task.interval })
      task.callback()
    }
    this.now = target
  }
}

class FakeStorage {
  readonly values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

class FakeChannel {
  static readonly channels = new Set<FakeChannel>()
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  readonly name: string

  constructor(name: string) {
    this.name = name
    FakeChannel.channels.add(this)
  }

  postMessage(message: unknown) {
    for (const channel of FakeChannel.channels) {
      if (channel !== this && channel.name === this.name) {
        channel.onmessage?.({ data: message } as MessageEvent<unknown>)
      }
    }
  }

  close() {
    FakeChannel.channels.delete(this)
  }
}

class FakeEventSource {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly url: string
  closed = false
  #listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.#listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    this.#listeners.get(type)?.delete(listener)
  }

  emitFlush(event: unknown) {
    const message = { data: JSON.stringify(event) } as MessageEvent<string>
    for (const listener of this.#listeners.get('flush') ?? []) listener(message)
  }

  close() {
    this.closed = true
  }
}

test('coalesces a flush burst with a trailing delay', () => {
  const clock = new FakeClock()
  let calls = 0
  const coalesced = createCoalescedCallback(() => calls++, {
    setTimer: clock.setTimeout,
    clearTimer: clock.clear,
  })

  coalesced.schedule()
  clock.advance(250)
  coalesced.schedule()
  clock.advance(299)
  assert.equal(calls, 0)
  clock.advance(1)
  assert.equal(calls, 1)
})

test('caps a continuous flush burst at the maximum wait', () => {
  const clock = new FakeClock()
  let calls = 0
  const coalesced = createCoalescedCallback(() => calls++, {
    setTimer: clock.setTimeout,
    clearTimer: clock.clear,
  })

  coalesced.schedule()
  for (let elapsed = 250; elapsed < 2_000; elapsed += 250) {
    clock.advance(250)
    coalesced.schedule()
  }
  assert.equal(calls, 0)
  clock.advance(250)
  assert.equal(calls, 1)
})

test('elects one stream leader, rebroadcasts flushes, and fails over after silence', () => {
  FakeChannel.channels.clear()
  const clock = new FakeClock()
  const storage = new FakeStorage()
  const sources: FakeEventSource[] = []
  const firstEvents: unknown[] = []
  const secondEvents: unknown[] = []
  const shared = {
    url: 'http://localhost/periscope/api/stream?application=default',
    eventSourceFactory: (url: string) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
    broadcastChannelFactory: (name: string) => new FakeChannel(name),
    storage,
    now: () => clock.now,
    setTimer: clock.setTimeout,
    clearTimer: clock.clear,
    setRepeatingTimer: clock.setInterval,
    clearRepeatingTimer: clock.clear,
  }
  const first = connectLiveUpdates({
    ...shared,
    createId: () => 'first',
    onFlush: (event) => firstEvents.push(event),
    onModeChange() {},
  })
  const second = connectLiveUpdates({
    ...shared,
    createId: () => 'second',
    onFlush: (event) => secondEvents.push(event),
    onModeChange() {},
  })

  assert.equal(sources.length, 1)
  assert.deepEqual(
    [...FakeChannel.channels].map((channel) => channel.name),
    ['periscope-sse', 'periscope-sse']
  )
  assert.equal(sources[0].url, shared.url)
  sources[0].emitFlush(validEvent)
  assert.deepEqual(firstEvents, [validEvent])
  assert.deepEqual(secondEvents, [validEvent])
  clock.advance(5_000)
  assert.equal(sources.length, 1)

  first.close()
  clock.advance(11_999)
  assert.equal(sources.length, 1)
  clock.advance(1)
  assert.equal(sources.length, 2)
  assert.equal(sources[0].closed, true)
  second.close()
})

test('falls back to a per-tab EventSource without BroadcastChannel', () => {
  const sources: FakeEventSource[] = []
  const connection = connectLiveUpdates({
    url: 'http://localhost/periscope/api/stream?application=admin',
    eventSourceFactory: (url) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
    broadcastChannelFactory: null,
    storage: new FakeStorage(),
    createId: () => 'fallback',
    onFlush() {},
    onModeChange() {},
  })

  assert.equal(sources.length, 1)
  assert.match(sources[0].url, /application=admin/)
  connection.close()
  assert.equal(sources[0].closed, true)
})
