/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The deliberately small identity Periscope keeps for an authenticated user. Authentication
 * providers commonly attach an ORM model to `ctx.auth.user`; retaining that model wholesale
 * would copy credentials, relations and application-specific state into every request entry.
 */
export type RequestAuthSummary = {
  id: string | number
  email?: string
}

/**
 * Uploaded files are useful request evidence, but their contents are neither bounded nor safe to
 * retain. These are the bodyparser fields needed to identify an upload without ever reading its
 * temporary file or in-memory bytes.
 */
export type RequestFileMetadata = {
  fieldName: string
  clientName: string
  size: number
  type?: string
  extname?: string
}

/**
 * Non-text response bodies are represented by their shape. Streams must not be consumed for a
 * preview, files must not be read back from disk, and binary bodies are rarely meaningful in a
 * debugging timeline even when they are small.
 */
export type RequestResponseMarker =
  { kind: 'stream' } | { kind: 'file'; path: string } | { kind: 'binary'; size: number }

/**
 * The primary entry closing an HTTP request batch. Every member is JSON-representable by the time
 * it reaches the recorder; application-owned values have already passed through `safeSerialize`.
 */
export type RequestEntryContent = Record<string, unknown> & {
  method: string
  url: string
  query: unknown
  routePattern?: string
  routeName?: string
  headers: Record<string, unknown>
  payload: unknown
  status: number | null
  durationMs: number
  user?: RequestAuthSummary
  memoryDeltaBytes: number
  ip: string
  hostname: string | null
  response?: unknown
  session?: unknown
  clientDisconnected: boolean
}
