/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { Stream } from 'node:stream'

/**
 * Implementation plan P1.3 — the value serialiser shared by the recorder and, from P3 onwards,
 * by the event, dump and job watchers.
 *
 * {@link safeSerialize} takes a value Periscope does not own — a controller's response body, an
 * event payload, an exception's `cause`, whatever a `dump()` call was handed — and returns a
 * value that is safe to store. "Safe" means four separate guarantees, all of which are load
 * bearing because this runs on the recording hot path against input Periscope cannot vet:
 *
 * - **JSON-representable.** Everything `JSON.stringify` cannot express (`undefined`, `bigint`,
 *   `symbol`, functions, `NaN`, circular references) is replaced by a readable `[marker]` string
 *   rather than being dropped or silently coerced to `null`. A key that is present but
 *   `undefined` stays visible, because "the key is there and empty" and "there is no key" are
 *   different bugs.
 * - **Bounded.** Depth is capped, and an approximate UTF-8 byte budget is spent as the walk
 *   proceeds; once it runs out the remaining siblings collapse into a single `[Truncated]`
 *   marker. A 10 000-element array or a 10 MB string costs a bounded amount of work rather than
 *   an input-sized one. *Every* emitted node is charged, containers included and before their
 *   children are walked — a node that renders bytes but pays nothing would let a runaway of
 *   empty containers or repeated markers overshoot `maxBytes` by an order of magnitude. The
 *   budget is approximate in one direction only: it may overshoot by roughly the scaffolding of
 *   the node in flight when it runs dry, because that node is priced before its children exist.
 * - **Non-throwing.** Every node is walked inside a guard. A throwing getter, a throwing
 *   `toJSON`, a proxy whose traps explode — each degrades to a marker for that one node and
 *   never propagates into the host application (plan §0, invariant 1).
 * - **Non-destructive.** The input is only read, never written, and things that would be
 *   consumed by reading them — streams — are elided by shape rather than inspected.
 *
 * The traversal is hand rolled rather than delegated to `util.inspect`: `inspect` produces a
 * string, and the dashboard needs structure it can render as a collapsible tree.
 */

/**
 * Markers emitted in place of values that cannot be represented. They are deliberately
 * bracket-wrapped so the dashboard can style them and a developer reading raw JSON can tell a
 * marker from a string the application really produced.
 */
const MARKER = {
  undefined: '[undefined]',
  circular: '[Circular]',
  depthLimit: '[Depth limit]',
  truncated: '[Truncated]',
  unserializable: '[Unserializable]',
} as const

/**
 * Approximate JSON punctuation cost of one array element, set value or map entry: the comma and
 * the brackets around it. Charged unconditionally per child so that a container of empty strings
 * still exhausts the budget instead of iterating a million free entries.
 */
const CHILD_COST = 2

/**
 * Approximate JSON punctuation cost of one object property, on top of the key's own length: two
 * quotes, a colon and a comma.
 */
const PROPERTY_COST = 4

/**
 * Approximate JSON punctuation cost of an emitted container's own scaffolding: the pair of
 * braces or brackets it contributes. Charged by every container *before* it walks its children,
 * because {@link CHILD_COST} alone prices what is inside a container and leaves the container
 * itself free — so a value made of nothing but empty arrays or objects used to render megabytes
 * against a 16 KB budget.
 */
const CONTAINER_COST = 2

/**
 * What a serialised `Map` or `Set` costs before a single entry is walked. Unlike an array or a
 * record it is emitted as a tagged wrapper, and that wrapper is not free:
 * `{"__type":"Map","size":0,"entries":[]}` is 38 bytes on its own. One byte is added for the
 * comma to the next sibling; the digits of a large `size` are lost in the noise, since a `Map`
 * big enough to widen that number has already spent the budget on its entries.
 */
const TAGGED_CONTAINER_COST = 39

/**
 * Same idea for the fixed three-key shape an `Error` is rendered as:
 * `{"name":"","message":"","stack":null}` is 37 bytes before the name, message and stack
 * strings are charged on top, plus the sibling comma.
 */
const ERROR_COST = 38

/**
 * Nominal cost of a rendered number. Rendering the number just to measure it would cost more
 * than the imprecision does; the budget is documented as approximate.
 */
const NUMBER_COST = 8

const BOOLEAN_COST = 5

const NULL_COST = 4

export type SerializeOptions = {
  /**
   * How many levels of object/array nesting are walked. The top-level value is depth 0, so a
   * container nested deeper than this becomes `[Depth limit]`.
   */
  maxDepth?: number

  /**
   * Approximate UTF-8 byte budget for the whole result.
   */
  maxBytes?: number
}

/**
 * The serializer owns these defaults outright — there is deliberately no `config.serialization`
 * knob mirroring them, because until a watcher needs to override the limits (P3.6's Event watcher
 * caps payloads at 8 KB by passing its own options) nothing would read it. 16 KB is roughly the
 * point past which a payload stops being readable in the dashboard anyway.
 */
export const SERIALIZER_DEFAULTS = {
  maxDepth: 4,
  maxBytes: 16_384,
} as const

/**
 * Remaining byte allowance, threaded through the whole walk by reference so that siblings
 * compete for one shared budget instead of each getting a private one.
 */
type Budget = { remaining: number }

/**
 * State carried across the recursion. `ancestors` holds the objects on the *current path* only —
 * see {@link safeSerialize} for why that distinction matters.
 */
type WalkState = {
  maxDepth: number
  ancestors: Set<object>
  budget: Budget
}

/**
 * Serialise `value` into a bounded, JSON-representable shape.
 *
 * Circularity is detected with an ancestors-on-the-current-path set rather than a global "seen"
 * set. The distinction is not academic: in an ORM result where the same `user` object hangs off
 * twenty rows, reporting nineteen of them as `[Circular]` would hide the very data a developer
 * opened the dashboard to read. Only a value that contains *itself* is a cycle.
 */
export function safeSerialize(value: unknown, options: SerializeOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? SERIALIZER_DEFAULTS.maxDepth
  const maxBytes = options.maxBytes ?? SERIALIZER_DEFAULTS.maxBytes

  return serializeNode(value, 0, {
    maxDepth: maxDepth > 0 ? maxDepth : 0,
    ancestors: new Set<object>(),
    budget: { remaining: maxBytes },
  })
}

/**
 * Per-node guard. Anything unexpected — a proxy trap, an exotic host object, a stack overflow on
 * a pathological `toJSON` chain — degrades this one node to a marker and lets its siblings
 * serialise normally.
 */
function serializeNode(value: unknown, depth: number, state: WalkState): unknown {
  try {
    return serializeUnguarded(value, depth, state)
  } catch {
    /**
     * A marker is still an emitted node. Charging it keeps an array of ten thousand hostile
     * proxies bounded by the budget rather than by the input's length.
     */
    state.budget.remaining -= MARKER.unserializable.length
    return MARKER.unserializable
  }
}

function serializeUnguarded(value: unknown, depth: number, state: WalkState): unknown {
  if (value === null) {
    state.budget.remaining -= NULL_COST
    return null
  }

  switch (typeof value) {
    case 'string':
      return chargeString(value, state.budget)

    case 'number':
      /**
       * `JSON.stringify` renders `NaN` and the infinities as `null`, erasing exactly the signal
       * someone debugging a numeric bug is looking for. Keep them as their string form.
       */
      if (!Number.isFinite(value)) {
        return chargeString(String(value), state.budget)
      }
      state.budget.remaining -= NUMBER_COST
      return value

    case 'boolean':
      state.budget.remaining -= BOOLEAN_COST
      return value

    case 'undefined':
      state.budget.remaining -= MARKER.undefined.length
      return MARKER.undefined

    case 'bigint':
      return chargeString(`${value}n`, state.budget)

    case 'symbol':
      return chargeString(value.toString(), state.budget)

    case 'function':
      return chargeString(`[Function: ${value.name || 'anonymous'}]`, state.budget)

    default: {
      /**
       * `null` was returned above and every other `typeof` bucket has its own case, so the only
       * thing left here is a real object.
       */
      const object = value as object
      return serializeObject(object, depth, state)
    }
  }
}

/**
 * Everything with `typeof value === 'object'`. The order of the branches is part of the
 * contract: the well-known types are recognised *before* `toJSON` is consulted, because several
 * of them define a `toJSON` whose output is worse than the compact form — `Buffer.toJSON()`
 * expands every single byte into an array element.
 */
function serializeObject(value: object, depth: number, state: WalkState): unknown {
  if (state.ancestors.has(value)) {
    state.budget.remaining -= MARKER.circular.length
    return MARKER.circular
  }

  if (value instanceof Date) {
    /**
     * `toISOString` throws on an invalid date, and an invalid date is exactly the kind of thing
     * worth seeing in a debug entry rather than losing to a marker.
     */
    const iso = Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
    return chargeString(iso, state.budget)
  }

  if (value instanceof RegExp) {
    return chargeString(String(value), state.budget)
  }

  if (value instanceof URL) {
    return chargeString(value.href, state.budget)
  }

  if (value instanceof Error) {
    /**
     * The three fields that make an error actionable. The stack is emitted whole; callers that
     * want a shorter one pass a smaller `maxBytes`, and the exception watcher caps it itself.
     */
    state.budget.remaining -= ERROR_COST
    return {
      name: chargeString(String(value.name), state.budget),
      message: chargeString(String(value.message), state.budget),
      stack: typeof value.stack === 'string' ? chargeString(value.stack, state.budget) : null,
    }
  }

  /**
   * Binary payloads are described, never transcribed: a 2 MB upload buffer has no debugging
   * value as two million array elements, and it would blow the whole budget on its own.
   */
  if (ArrayBuffer.isView(value)) {
    const kind = constructorName(value) ?? 'TypedArray'
    return chargeString(`[${kind} ${value.byteLength} bytes]`, state.budget)
  }

  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
    const kind = constructorName(value) ?? 'ArrayBuffer'
    return chargeString(`[${kind} ${value.byteLength} bytes]`, state.budget)
  }

  /**
   * Streams are identified by shape as well as by prototype, because plenty of ecosystem objects
   * are stream-like without extending `node:stream`. Reading one to serialise it would consume
   * the very body the host application is about to send.
   */
  if (isStreamLike(value)) {
    return chargeString(`[Stream ${constructorName(value) ?? 'Stream'}]`, state.budget)
  }

  /**
   * Only containers are elided by the depth limit. The leaf forms above collapse to a single
   * scalar whatever their nesting, so cutting them off would lose information for free.
   */
  if (depth > state.maxDepth) {
    state.budget.remaining -= MARKER.depthLimit.length
    return MARKER.depthLimit
  }

  if (value instanceof Map) {
    const map: Map<unknown, unknown> = value
    return serializeMap(map, depth, state)
  }

  if (value instanceof Set) {
    const set: Set<unknown> = value
    return serializeSet(set, depth, state)
  }

  /**
   * `toJSON` is the value's own opinion about how it should be persisted — Luxon `DateTime`,
   * Lucid models and most domain value objects define one. Honour it, but never trust it: a
   * throwing `toJSON` is reported, not propagated.
   */
  if ('toJSON' in value && typeof value.toJSON === 'function') {
    let produced: unknown
    try {
      produced = Reflect.apply(value.toJSON, value, [])
    } catch (error) {
      return chargeString(`[toJSON threw: ${errorMessage(error)}]`, state.budget)
    }

    /**
     * The result stands in for the value at the same depth, so `value` joins the ancestor path
     * to stop a `toJSON` that returns `this` from recursing forever.
     */
    state.ancestors.add(value)
    try {
      return serializeNode(produced, depth, state)
    } finally {
      state.ancestors.delete(value)
    }
  }

  if (Array.isArray(value)) {
    const items: unknown[] = value
    return serializeArray(items, depth, state)
  }

  return serializeRecord(value, depth, state)
}

/**
 * `Map` keys are frequently objects, which is precisely why a `Map` cannot be flattened into a
 * plain object. Entries stay as `[key, value]` pairs, both sides recursed through the same
 * depth and budget machinery.
 */
function serializeMap(
  map: Map<unknown, unknown>,
  depth: number,
  state: WalkState
): Record<string, unknown> {
  const entries: unknown[] = []
  state.budget.remaining -= TAGGED_CONTAINER_COST

  state.ancestors.add(map)
  try {
    for (const [key, item] of map) {
      if (state.budget.remaining <= 0) {
        entries.push(MARKER.truncated)
        break
      }
      state.budget.remaining -= CHILD_COST
      entries.push([serializeNode(key, depth + 1, state), serializeNode(item, depth + 1, state)])
    }
  } finally {
    state.ancestors.delete(map)
  }

  return { __type: 'Map', size: map.size, entries }
}

function serializeSet(set: Set<unknown>, depth: number, state: WalkState): Record<string, unknown> {
  const values: unknown[] = []
  state.budget.remaining -= TAGGED_CONTAINER_COST

  state.ancestors.add(set)
  try {
    for (const item of set) {
      if (state.budget.remaining <= 0) {
        values.push(MARKER.truncated)
        break
      }
      state.budget.remaining -= CHILD_COST
      values.push(serializeNode(item, depth + 1, state))
    }
  } finally {
    state.ancestors.delete(set)
  }

  return { __type: 'Set', size: set.size, values }
}

function serializeArray(items: unknown[], depth: number, state: WalkState): unknown[] {
  const out: unknown[] = []
  state.budget.remaining -= CONTAINER_COST

  state.ancestors.add(items)
  try {
    for (const item of items) {
      if (state.budget.remaining <= 0) {
        out.push(MARKER.truncated)
        break
      }
      state.budget.remaining -= CHILD_COST
      out.push(serializeNode(item, depth + 1, state))
    }
  } finally {
    state.ancestors.delete(items)
  }

  return out
}

/**
 * Plain objects and class instances. Only own enumerable string keys are walked: prototype
 * methods are noise and symbol keys have no JSON representation. Instances additionally carry a
 * `__class` key, because "which model was this?" is usually the first question asked of a
 * serialised object — `Object.create(null)` bags and plain literals have no such answer to give.
 */
function serializeRecord(value: object, depth: number, state: WalkState): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  state.budget.remaining -= CONTAINER_COST

  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) {
    const className = constructorName(value)
    if (className !== undefined && className !== 'Object') {
      state.budget.remaining -= PROPERTY_COST + '__class'.length
      out.__class = chargeString(className, state.budget)
    }
  }

  state.ancestors.add(value)
  try {
    for (const key of Object.keys(value)) {
      if (state.budget.remaining <= 0) {
        out[MARKER.truncated] = true
        break
      }
      state.budget.remaining -= key.length + PROPERTY_COST

      const serialized = readProperty(value, key, depth, state)

      /**
       * `out.__proto__ = x` retargets the output's prototype instead of adding a key, which
       * would both lose the property and corrupt the result. An input can genuinely own that
       * key — `JSON.parse('{"__proto__":1}')` produces one — so write it as a data property.
       */
      if (key === '__proto__') {
        Object.defineProperty(out, key, {
          value: serialized,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      } else {
        out[key] = serialized
      }
    }
  } finally {
    state.ancestors.delete(value)
  }

  return out
}

/**
 * Reads one own property. The read itself is guarded because the property may be an accessor —
 * a Lucid relation that was never loaded, a lazily computed field — and a getter that throws
 * must cost its own value, not the whole entry.
 */
function readProperty(target: object, key: string, depth: number, state: WalkState): unknown {
  let raw: unknown
  try {
    raw = Reflect.get(target, key)
  } catch (error) {
    return chargeString(`[Getter threw: ${errorMessage(error)}]`, state.budget)
  }

  return serializeNode(raw, depth + 1, state)
}

/**
 * Spends `value`'s approximate UTF-8 weight from the budget, returning it whole when it fits and
 * a truncated head otherwise. Strings are the only unbounded leaf: a single 10 MB request body
 * would blow the budget no matter how careful the container walk is.
 */
function chargeString(value: string, budget: Budget): string {
  /**
   * A UTF-8 encoding is never shorter than the string's UTF-16 code-unit count, so anything
   * longer than the remaining budget cannot fit — no need to measure ten megabytes to find out.
   */
  if (value.length <= budget.remaining) {
    const cost = Buffer.byteLength(value)
    if (cost <= budget.remaining) {
      budget.remaining -= cost
      return value
    }
  }

  const keep = budget.remaining > 0 ? budget.remaining : 0
  budget.remaining = 0

  /**
   * A code unit can weigh up to three UTF-8 bytes, so the character slice is re-cut by the
   * measured ratio until it fits. Every pass strictly shortens the slice, so this terminates.
   */
  let head = value.slice(0, keep)
  let bytes = Buffer.byteLength(head)
  while (bytes > keep) {
    head = head.slice(0, Math.floor((head.length * keep) / bytes))
    bytes = Buffer.byteLength(head)
  }

  return `${head}${MARKER.truncated}`
}

/**
 * The constructor name, when the object has a usable one. `Object.create(null)` bags and
 * anonymous classes have none, and the caller must not invent one for them.
 */
function constructorName(value: object): string | undefined {
  if (!('constructor' in value) || typeof value.constructor !== 'function') {
    return undefined
  }

  return value.constructor.name.length > 0 ? value.constructor.name : undefined
}

function isStreamLike(value: object): boolean {
  if (value instanceof Stream) {
    return true
  }

  return (
    'pipe' in value &&
    typeof value.pipe === 'function' &&
    'on' in value &&
    typeof value.on === 'function'
  )
}

/**
 * Best-effort message for a thrown value, itself unable to throw: `String(x)` runs a `toString`
 * that may be every bit as broken as whatever threw in the first place.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message
  }

  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
