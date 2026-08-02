import type { EntryContent } from '../types.ts'

export type EntryContentDiff = {
  key: string
  left: unknown
  right: unknown
  status: 'same' | 'changed' | 'left-only' | 'right-only'
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    )
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key])
    )
  )
}

/**
 * Compares top-level content keys while treating nested JSON objects as values. This keeps the
 * diff aligned with the recorder's stable content schema rather than producing a noisy line diff.
 */
export function diffEntryContent(left: EntryContent, right: EntryContent): EntryContentDiff[] {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  return keys.map((key) => {
    const hasLeft = Object.hasOwn(left, key)
    const hasRight = Object.hasOwn(right, key)
    let status: EntryContentDiff['status'] = 'same'
    if (!hasRight) status = 'left-only'
    else if (!hasLeft) status = 'right-only'
    else if (!valuesEqual(left[key], right[key])) status = 'changed'
    return { key, left: left[key], right: right[key], status }
  })
}
