import assert from 'node:assert/strict'
import test from 'node:test'

import { api } from './api.ts'

test('bootstrap a Shield token and protect every mutation with dashboard-only headers', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; options: RequestInit }> = []

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'https://example.test/periscope/#/requests' } },
  })
  globalThis.fetch = (async (input, options = {}) => {
    const url = String(input)
    requests.push({ url, options })

    if (url.endsWith('/api/csrf-token')) {
      return new Response(JSON.stringify({ token: 'shield-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    return new Response(null, { status: 204 })
  }) as typeof fetch

  try {
    await api.clear('tenant-a')
    await api.monitorTag('slow query')
    await api.setExceptionGroupState('family/a', 'resolved', 'tenant-a')

    assert.equal(requests.length, 4)
    assert.equal(requests[0].url, 'https://example.test/periscope/api/csrf-token')
    assert.equal(requests[1].url, 'https://example.test/periscope/api/clear?application=tenant-a')
    assert.equal(requests[2].url, 'https://example.test/periscope/api/monitored-tags/slow%20query')
    assert.equal(
      requests[3].url,
      'https://example.test/periscope/api/exception-groups/family%2Fa/state'
    )
    assert.deepEqual(JSON.parse(String(requests[3].options.body)), {
      state: 'resolved',
      application: 'tenant-a',
    })

    for (const request of requests.slice(1)) {
      const headers = new Headers(request.options.headers)
      assert.equal(headers.get('x-periscope-request'), 'dashboard')
      assert.equal(headers.get('x-csrf-token'), 'shield-token')
      assert.equal(request.options.credentials, 'same-origin')
    }
  } finally {
    globalThis.fetch = originalFetch
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('serializes full-text, time, and repeated exact-tag entry filters', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  let requestedUrl = ''

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'https://example.test/periscope/#/search' } },
  })
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input)
    return new Response(JSON.stringify({ data: [], nextCursor: null }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await api.listEntries({
      type: 'request',
      text: 'checkout failed',
      from: '2026-07-29T10:00:00.000Z',
      to: '2026-07-29T11:00:00.000Z',
      tag: 'slow',
      tags: ['slow', 'tenant:acme'],
      limit: 50,
    })

    const url = new URL(requestedUrl)
    assert.equal(url.pathname, '/periscope/api/entries')
    assert.equal(url.searchParams.get('text'), 'checkout failed')
    assert.equal(url.searchParams.get('from'), '2026-07-29T10:00:00.000Z')
    assert.equal(url.searchParams.get('to'), '2026-07-29T11:00:00.000Z')
    assert.deepEqual(url.searchParams.getAll('tag'), ['slow', 'tenant:acme'])
  } finally {
    globalThis.fetch = originalFetch
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
