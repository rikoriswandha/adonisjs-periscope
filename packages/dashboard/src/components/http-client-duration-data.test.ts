import assert from 'node:assert/strict'
import test from 'node:test'

import { buildHttpClientDurationData, isHttpClientFailure } from './http-client-duration-data.ts'
import type { HttpClientContent, StoredEntry } from '../types.ts'

function entry(sequence: string, content: HttpClientContent): StoredEntry {
  return {
    uuid: `entry-${sequence}`,
    batchId: 'batch',
    type: 'http_client',
    familyHash: null,
    content,
    tags: [],
    shouldDisplayOnIndex: true,
    sequence,
    createdAt: `2026-07-26T00:00:0${sequence}.000Z`,
  }
}

test('includes finite transport failures while excluding pending and non-finite samples', () => {
  const transportFailure: HttpClientContent = {
    method: 'GET',
    url: 'https://unreachable.test',
    durationMs: 125,
    completed: false,
    error: { name: 'Error', message: 'connect ECONNREFUSED' },
  }
  const data = buildHttpClientDurationData([
    entry('3', {
      method: 'GET',
      url: 'https://pending.test',
      durationMs: 10,
      completed: false,
    }),
    entry('2', transportFailure),
    entry('1', {
      method: 'GET',
      url: 'https://completed.test',
      durationMs: 25,
      completed: true,
      status: 200,
    }),
    entry('4', {
      method: 'GET',
      url: 'https://invalid.test',
      durationMs: Number.NaN,
      completed: true,
    }),
  ])

  assert.deepEqual(
    data.map(({ content, duration }) => [content.url, duration]),
    [
      ['https://completed.test', 25],
      ['https://unreachable.test', 125],
    ]
  )
  assert.equal(data.filter(({ content }) => isHttpClientFailure(content)).length, 1)
})
