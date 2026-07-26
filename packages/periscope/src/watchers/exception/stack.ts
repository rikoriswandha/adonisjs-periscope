/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { ExceptionCodeFrameLine, ExceptionStackFrame } from './types.ts'

/**
 * Stack traces are application input too. A pathological `Error.prepareStackTrace` can produce
 * thousands of lines, and retaining all of them would turn one exception into an unbounded hot
 * path. A hundred frames is already far past the point at which a stack remains useful.
 */
const MAX_STACK_FRAMES = 100

/**
 * Reading source is deliberately bounded. Most source files are far smaller than this; a
 * generated multi-megabyte bundle is both expensive to read synchronously and useless as a code
 * frame, so a target beyond the prefix simply has no frame.
 */
const MAX_SOURCE_BYTES = 512 * 1024
const MAX_RADIUS = 20

/**
 * V8 rewrites `error.stack` through source maps when Node runs with `--enable-source-maps` (as
 * Periscope's tests and playground do). Parsing that already-mapped string keeps this package
 * dependency-free and avoids implementing a second, subtly different source-map resolver.
 */
export function parseStack(stack: string): ExceptionStackFrame[] {
  const frames: ExceptionStackFrame[] = []

  for (const raw of stack.split('\n')) {
    if (frames.length >= MAX_STACK_FRAMES) {
      break
    }

    const frame = parseStackLine(raw)
    if (frame !== undefined) {
      frames.push(frame)
    }
  }

  return frames
}

/**
 * Parse the two ordinary V8 forms, `at fn (file:line:column)` and
 * `at file:line:column`. Matching the numeric suffix from the right also handles `node:` URLs,
 * file URLs and Windows drive letters without treating their colons as separators.
 *
 * Eval frames need an earlier, explicit branch. Their outer location contains a second
 * parenthesized `eval at` origin followed by the actual inner location, so treating the final
 * opening parenthesis as an ordinary frame boundary combines both locations into a path that
 * never existed. Recording the inner location is honest; V8's usual `<anonymous>` target is
 * deliberately classified as native so it cannot become an application family-hash or
 * code-frame candidate.
 */
function parseStackLine(raw: string): ExceptionStackFrame | undefined {
  const match = /^\s*at\s+(.+)$/.exec(raw)
  if (match === null) {
    return undefined
  }

  const body = match[1]
  const evalAt = body.indexOf(' (eval at ')

  if (evalAt !== -1 && body.endsWith(')')) {
    const innerLocation = /,\s*(.+:\d+:\d+)\)$/.exec(body)

    if (innerLocation !== null) {
      return frameFromLocation(innerLocation[1], normalizeFunctionName(body.slice(0, evalAt)), raw)
    }
  }

  const parenthesis = body.lastIndexOf(' (')
  const hasParenthesizedLocation = parenthesis !== -1 && body.endsWith(')')
  const functionName = hasParenthesizedLocation
    ? normalizeFunctionName(body.slice(0, parenthesis))
    : null
  const rawLocation = hasParenthesizedLocation ? body.slice(parenthesis + 2, -1) : body
  const location =
    !hasParenthesizedLocation && rawLocation.startsWith('async ')
      ? rawLocation.slice('async '.length)
      : rawLocation

  return frameFromLocation(location, functionName, raw)
}

function frameFromLocation(
  location: string,
  functionName: string | null,
  raw: string
): ExceptionStackFrame | undefined {
  const coordinates = /^(.*):(\d+):(\d+)$/.exec(location)

  if (coordinates !== null) {
    const file = normalizeFile(coordinates[1])
    const normalized = file.replaceAll('\\', '/')
    const type: ExceptionStackFrame['type'] =
      file.startsWith('node:') || file.includes('<anonymous>')
        ? 'native'
        : normalized.startsWith('node_modules/') || normalized.includes('/node_modules/')
          ? 'module'
          : 'app'

    return {
      file,
      line: Number(coordinates[2]),
      column: Number(coordinates[3]),
      function: functionName,
      type,
      raw,
    }
  }

  if (location === 'native' || location === '<anonymous>') {
    return {
      file: location,
      line: null,
      column: null,
      function: functionName,
      type: 'native',
      raw,
    }
  }

  return undefined
}

function normalizeFunctionName(functionName: string): string | null {
  const normalized = functionName.startsWith('async ')
    ? functionName.slice('async '.length)
    : functionName
  return normalized.length === 0 ? null : normalized
}

function normalizeFile(file: string): string {
  if (!file.startsWith('file://')) {
    return file
  }

  try {
    return fileURLToPath(file)
  } catch {
    return file
  }
}

/**
 * Read a bounded source prefix and return the lines surrounding `frame`. Every filesystem
 * operation is guarded because this runs synchronously from an application's exception reporter:
 * a deleted source file, a permissions error or even a failed close must never replace the
 * application's original error.
 */
export function codeFrame(
  frame: ExceptionStackFrame,
  radius: number = 5
): ExceptionCodeFrameLine[] | undefined {
  if (frame.line === null || frame.line < 1 || frame.type !== 'app') {
    return undefined
  }

  let descriptor: number | undefined

  try {
    descriptor = openSync(frame.file, 'r')
    const bytes = Math.min(fstatSync(descriptor).size, MAX_SOURCE_BYTES)

    if (bytes === 0) {
      return undefined
    }

    const buffer = Buffer.allocUnsafe(bytes)
    const bytesRead = readSync(descriptor, buffer, 0, bytes, 0)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)

    if (frame.line > lines.length) {
      return undefined
    }

    const normalizedRadius = Number.isFinite(radius) ? Math.trunc(radius) : 5
    const safeRadius = Math.min(MAX_RADIUS, Math.max(0, normalizedRadius))
    const first = Math.max(1, frame.line - safeRadius)
    const last = Math.min(lines.length, frame.line + safeRadius)
    const result: ExceptionCodeFrameLine[] = []

    for (let line = first; line <= last; line++) {
      result.push({
        line,
        source: lines[line - 1],
        highlight: line === frame.line,
      })
    }

    return result
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        /** A close failure is no more actionable to the host than a read failure. */
      }
    }
  }
}
