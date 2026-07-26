/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * One location from a V8 stack. Missing line and column numbers are represented by `null` rather
 * than invented: native frames such as `Array.forEach (native)` genuinely do not have a source
 * coordinate, but they remain useful context in the timeline.
 */
export type ExceptionStackFrame = {
  file: string
  line: number | null
  column: number | null
  function: string | null
  type: 'app' | 'module' | 'native'
  raw: string
}

/**
 * A source line surrounding the first application frame. The marker is data rather than display
 * punctuation so the dashboard can render the frame appropriately in HTML, ANSI or plain text.
 */
export type ExceptionCodeFrameLine = {
  line: number
  source: string
  highlight: boolean
}

export type ExceptionRequestSummary = {
  method: string
  url: string
  route?: {
    pattern: string
    name?: string
  }
}

/**
 * The JSON-representable exception payload stored by {@link ExceptionWatcher}. `context` is
 * intentionally unknown at the type boundary: application-owned values pass through
 * `safeSerialize` before they are assigned here.
 */
export type ExceptionEntryContent = {
  name: string
  message: string
  code?: string
  status?: number
  stack: string
  frames: ExceptionStackFrame[]
  codeFrame?: ExceptionCodeFrameLine[]
  request?: ExceptionRequestSummary
  context?: unknown
}
