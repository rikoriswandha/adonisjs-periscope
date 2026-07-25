/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { ResolvedPeriscopeConfig } from '../types.ts'

/**
 * Implementation plan P1.3: deep key-deny-list scrubbing.
 *
 * Redaction is the last line of defence between a host application's secrets and Periscope's
 * storage. It runs inside the recorder pipeline *before* an entry is buffered (architecture
 * §6.1: `... -> filter hooks -> redaction -> tag hooks -> ...`), which has two consequences
 * this module is built around:
 *
 * - Tag hooks and everything downstream only ever see scrubbed content, so a hook cannot leak
 *   a secret into a tag by accident.
 * - The host application still owns the object the watcher handed over. Redaction therefore
 *   never mutates its input; it returns a new structure and leaves the caller's object alone.
 */

/**
 * Keys whose values are scrubbed by default, wherever they appear at any depth.
 *
 * Spelling here is only a hint: matching is normalised (see {@link normaliseKey}), so
 * `api_key` in this list also covers `apiKey`, `API-KEY` and `apikey`. Both `api_key` and
 * `apikey` are listed anyway because this array is the documented default an application
 * spreads into its own config, and it should read like a checklist rather than a puzzle.
 */
export const DEFAULT_REDACT_KEYS = [
  'password',
  'password_confirmation',
  'current_password',
  'new_password',
  'secret',
  'client_secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'private_key',
  'authorization',
  'auth',
  'cookie',
  'session_id',
  'csrf_token',
  'xsrf_token',
  'credit_card',
  'card_number',
  'cvv',
  'cvc',
  'ssn',
  'pin',
  'otp',
  'passphrase',
] as const

/**
 * HTTP headers whose values are scrubbed by default.
 *
 * Unlike {@link DEFAULT_REDACT_KEYS} these are matched case-insensitively but *literally*:
 * `x-api-key` and `xapikey` are different headers, and collapsing separators here would scrub
 * headers an application never asked to hide.
 */
export const DEFAULT_REDACT_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
] as const

/**
 * Stand-in written where a cycle is detected. Content reaching the redactor has normally been
 * through `safeSerialize` already, which breaks cycles itself — but the redactor is public API
 * and a hostile or hand-built payload must not be able to hang the recorder.
 */
const CIRCULAR = '[Circular]'

/**
 * Collapse a key to its comparable form: lowercase, then everything that is not `a-z` or `0-9`
 * removed. This is what makes one configured `apiKey` cover `api_key`, `API-KEY`, `api key`
 * and `apikey` without an application having to enumerate naming conventions.
 *
 * The comparison is whole-key, never a substring, so `passwordHint` does not match `password`.
 */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Whether the value is a bare object literal — the only object shape the walker is allowed to
 * rebuild. `Date`, `Buffer`, `Map`, class instances and anything else with a real prototype are
 * passed through by identity: reconstructing them faithfully is impossible in the general case,
 * and Periscope's job here is to be harmless, not clever.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

/**
 * Write one own, enumerable key onto a freshly built plain object.
 *
 * `target.__proto__ = value` retargets the object's prototype instead of adding a key, which
 * would both lose the property and corrupt the result. An input can genuinely own that key —
 * `JSON.parse('{"__proto__":{}}')` produces one, and Periscope records parsed request bodies, so
 * the payload reaching here is routinely attacker-supplied — hence the same `Object.defineProperty`
 * guard `serializeRecord` uses in `serializer.ts`, for the same reason.
 */
function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })

    return
  }

  target[key] = value
}

/**
 * Scrubs configured keys and headers out of entry content.
 *
 * One instance is built per application from `ResolvedPeriscopeConfig['redact']` and reused for
 * every recorded entry, so all the per-configuration work — normalising the deny list into a
 * lookup set — happens once in the constructor and never on the hot path.
 */
export class Redactor {
  /**
   * Normalised deny list. A `Set` rather than a `Record` because it is built from runtime
   * configuration and only ever asked "is this key in it?".
   */
  readonly #keys: Set<string>

  /**
   * Lowercased header names, matched literally.
   */
  readonly #headers: Set<string>

  readonly #replacement: string

  constructor(config: ResolvedPeriscopeConfig['redact']) {
    this.#keys = new Set<string>()
    for (const key of config.keys) {
      const normalised = normaliseKey(key)

      /**
       * A key made entirely of separators normalises to the empty string, which would then
       * match every other all-separator key. Dropping it is the only sane reading of it.
       */
      if (normalised !== '') {
        this.#keys.add(normalised)
      }
    }

    this.#headers = new Set(config.headers.map((header) => header.toLowerCase()))
    this.#replacement = config.replacement
  }

  /**
   * Return a copy of `value` with the value of every matching key replaced, at any depth,
   * inside plain objects and arrays.
   *
   * Matching is by key, not by value: whatever a matching key holds — a string, a number, a
   * whole nested object, `null` — is replaced wholesale, because a secret nested one level
   * below `credentials` is still a secret.
   *
   * The input is never mutated. Subtrees are rebuilt unconditionally rather than only when
   * something below them changed; the extra allocation is worth not having to reason about
   * partial structural sharing every time this code is read.
   *
   * Depth is unbounded — the serializer owns depth capping — but cycles are guarded, so the
   * walk always terminates.
   */
  redact<T>(value: T): T {
    if (this.#keys.size === 0) {
      return value
    }

    return this.#walk(value, new Set<object>()) as T
  }

  /**
   * Return a copy of `headers` with every configured header replaced.
   *
   * Node hands some headers over as arrays (`set-cookie` in particular); those collapse to the
   * replacement string rather than an array of replacements, since the count of cookies is
   * itself mildly interesting information nobody asked to keep.
   */
  redactHeaders<T extends Record<string, unknown>>(headers: T): T {
    if (this.#headers.size === 0) {
      return headers
    }

    const result: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(headers)) {
      setKey(result, name, this.#headers.has(name.toLowerCase()) ? this.#replacement : value)
    }

    return result as T
  }

  /**
   * Recursive worker. `ancestors` holds the containers on the current path only — entries are
   * removed on the way back up — so a value repeated across sibling branches is still walked,
   * while a true cycle short-circuits to {@link CIRCULAR}.
   */
  #walk(value: unknown, ancestors: Set<object>): unknown {
    if (Array.isArray(value)) {
      if (ancestors.has(value)) {
        return CIRCULAR
      }

      ancestors.add(value)
      /**
       * No guard is needed on this branch: `map` defines index keys as data properties on a
       * fresh array and never writes a named own key, so an array carrying `__proto__` cannot
       * retarget the copy's prototype.
       */
      const items = value.map((item) => this.#walk(item, ancestors))
      ancestors.delete(value)

      return items
    }

    if (!isPlainObject(value)) {
      return value
    }

    if (ancestors.has(value)) {
      return CIRCULAR
    }

    ancestors.add(value)
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      setKey(
        result,
        key,
        this.#keys.has(normaliseKey(key)) ? this.#replacement : this.#walk(item, ancestors)
      )
    }
    ancestors.delete(value)

    return result
  }
}
