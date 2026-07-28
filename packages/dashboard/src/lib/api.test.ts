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

    assert.equal(requests.length, 3)
    assert.equal(requests[0].url, 'https://example.test/periscope/api/csrf-token')
    assert.equal(requests[1].url, 'https://example.test/periscope/api/clear?application=tenant-a')
    assert.equal(requests[2].url, 'https://example.test/periscope/api/monitored-tags/slow%20query')

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
