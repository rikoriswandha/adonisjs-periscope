/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { PeriscopeError } from './errors.ts'
import { serializeEntry } from './http/serialize.ts'
import type { StoredEntryTransport } from './http/serialize.ts'
import type { StoredEntry } from './types.ts'

export const BATCH_EXPORT_FORMAT = 'periscope.batch'
export const BATCH_EXPORT_VERSION = 1

export type BatchExportV1 = {
  format: typeof BATCH_EXPORT_FORMAT
  version: typeof BATCH_EXPORT_VERSION
  batchId: string
  application: string
  entries: StoredEntryTransport[]
}

function invalid(path: string, problem: string): never {
  throw new PeriscopeError(`${path} ${problem}`)
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(path, 'must be an object')
  }

  return value as Record<string, unknown>
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    return invalid(path, 'must be a string')
  }

  return value
}

function parseEntry(value: unknown, index: number): StoredEntry {
  const path = `entries[${index}]`
  const entry = requireRecord(value, path)
  const content = requireRecord(entry.content, `${path}.content`)

  const tags = entry.tags

  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    return invalid(`${path}.tags`, 'must be an array of strings')
  }

  if (typeof entry.shouldDisplayOnIndex !== 'boolean') {
    return invalid(`${path}.shouldDisplayOnIndex`, 'must be a boolean')
  }

  const sequenceValue = requireString(entry.sequence, `${path}.sequence`)
  if (!/^-?\d+$/.test(sequenceValue)) {
    return invalid(`${path}.sequence`, 'must be an integer string')
  }
  const sequence = BigInt(sequenceValue)

  const createdAtValue = requireString(entry.createdAt, `${path}.createdAt`)
  const createdAt = new Date(createdAtValue)
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== createdAtValue) {
    return invalid(`${path}.createdAt`, 'is not an ISO date')
  }

  const familyHash = entry.familyHash
  if (familyHash !== null && typeof familyHash !== 'string') {
    return invalid(`${path}.familyHash`, 'must be a string or null')
  }

  return {
    uuid: requireString(entry.uuid, `${path}.uuid`),
    batchId: requireString(entry.batchId, `${path}.batchId`),
    application: requireString(entry.application, `${path}.application`),
    type: requireString(entry.type, `${path}.type`) as StoredEntry['type'],
    familyHash,
    content,
    tags: [...tags],
    shouldDisplayOnIndex: entry.shouldDisplayOnIndex,
    sequence,
    createdAt,
  }
}

/**
 * Parse and validate a portable Periscope batch export.
 */
export function parseBatchExport(json: string): {
  batchId: string
  application: string
  entries: StoredEntry[]
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new PeriscopeError('Batch export is not valid JSON')
  }

  const envelope = requireRecord(parsed, 'batch export')
  if (envelope.format !== BATCH_EXPORT_FORMAT) {
    throw new PeriscopeError(
      `Unsupported batch export format "${String(envelope.format)}"; expected "${BATCH_EXPORT_FORMAT}"`
    )
  }

  if (envelope.version !== BATCH_EXPORT_VERSION) {
    throw new PeriscopeError(
      `Unsupported batch export version ${String(envelope.version)}; supported version is ${BATCH_EXPORT_VERSION}`
    )
  }

  const batchId = requireString(envelope.batchId, 'batchId')
  const application = requireString(envelope.application, 'application')
  if (!Array.isArray(envelope.entries)) {
    throw new PeriscopeError('entries must be an array')
  }

  return {
    batchId,
    application,
    entries: envelope.entries.map(parseEntry),
  }
}

/**
 * Serialize a stored batch into Periscope's portable, versioned export format.
 */
export function serializeBatchExport(
  batchId: string,
  entries: readonly StoredEntry[]
): string | null {
  const first = entries[0]
  if (first === undefined) {
    return null
  }

  return JSON.stringify(
    {
      format: BATCH_EXPORT_FORMAT,
      version: BATCH_EXPORT_VERSION,
      batchId,
      application: first.application,
      entries: entries.map(serializeEntry),
    },
    null,
    2
  )
}
