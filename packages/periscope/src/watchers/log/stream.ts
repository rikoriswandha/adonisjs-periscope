/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { IncomingEntry } from '../../entry.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType } from '../../types.ts'
import type { LogLevelName } from '../../types.ts'
import type { LogEntryContent, PeriscopeLogStream, PeriscopeLogStreamOptions } from './types.ts'

/**
 * Pino checks this global symbol before every write. Opting into the protocol makes it attach the
 * already-computed record metadata to the destination, so Periscope never has to parse every JSON
 * line produced by a busy application just to discard most of them at the configured threshold.
 */
const PINO_METADATA = Symbol.for('pino.metadata')

/**
 * Periscope config intentionally accepts pino's six standard levels only. The threshold therefore
 * has a stable numeric meaning even when the application adds custom levels of its own; labels for
 * records are still read from the emitting logger so a custom level remains intelligible.
 */
const LEVEL_NUMBERS: Record<LogLevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

const STANDARD_LABELS: Record<number, LogLevelName> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

/**
 * Metadata arrives from pino as unknown application-owned objects. This predicate is deliberately
 * structural: child loggers inherit methods and level maps through pino's prototype chain, so an
 * own-property test would reject exactly the request-scoped loggers the watcher is meant to see.
 */
function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function recordFrom(value: unknown): Record<string, unknown> {
  return isObjectLike(value) ? (value as Record<string, unknown>) : {}
}

/**
 * Read the full child-binding set from the raw pino instance. Calling with the logger as `this` is
 * significant: pino's implementation reads private symbols from the receiver, including inherited
 * chindings on request children.
 */
function loggerBindings(logger: unknown): Record<string, unknown> {
  if (!isObjectLike(logger) || typeof logger.bindings !== 'function') {
    return {}
  }

  return recordFrom(logger.bindings.call(logger))
}

/**
 * Prefer the emitting logger's level table so custom pino levels retain their application-defined
 * label. The fixed table is only a fallback for malformed metadata and for the six standard levels
 * whose numbers pino guarantees.
 */
function levelLabel(logger: unknown, levelNumber: number): string {
  if (isObjectLike(logger) && isObjectLike(logger.levels) && isObjectLike(logger.levels.labels)) {
    const label = logger.levels.labels[levelNumber]

    if (typeof label === 'string') {
      return label
    }
  }

  return STANDARD_LABELS[levelNumber] ?? String(levelNumber)
}

/**
 * `lastTime` is not the parsed timestamp. It is pino's raw time fragment after the key, which is a
 * decimal string for epoch time and a quoted string for ISO time. Coercing the former and removing
 * the quotes from the latter preserves the configured representation without parsing the log line.
 */
function metadataTime(value: string): number | string | null {
  if (value.length === 0) {
    return null
  }

  const numeric = Number(value)

  if (Number.isFinite(numeric)) {
    return numeric
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }

  return value
}

/**
 * Build the context in wire-order: child bindings first, then the merging object. Pino writes them
 * in that order too, so an explicit field on `logger.error({ request_id: ... })` wins over the
 * inherited child binding. Process identity and logger-channel fields are transport noise rather
 * than debugging context and are removed after the merge.
 */
function serializeContext(
  bindings: Record<string, unknown>,
  mergingObject: Record<string, unknown>
): Record<string, unknown> {
  const context = { ...bindings, ...mergingObject }

  delete context.pid
  delete context.hostname
  delete context.name

  const serialized = safeSerialize(context)

  return recordFrom(serialized)
}

/**
 * Create a metadata-aware pino destination that records log entries without parsing their JSON
 * lines. `write()` is invoked inside pino's own call stack, so the entire read/build/record path is
 * guarded: a hostile merging object or a surprising logger implementation can drop one record but
 * can never throw back through the application's logging statement.
 */
export function periscopeLogStream(options: PeriscopeLogStreamOptions): PeriscopeLogStream {
  const threshold = LEVEL_NUMBERS[options.level]
  const stats = { recorded: 0 }

  const stream: PeriscopeLogStream & { [PINO_METADATA]: true } = {
    [PINO_METADATA]: true,
    lastLevel: 0,
    lastTime: '',
    lastMsg: undefined,
    lastObj: {},
    lastLogger: undefined,
    stats,

    write(_line: string): void {
      safeguard('periscope.log.write', () => {
        if (stream.lastLevel < threshold) {
          return
        }

        const bindings = loggerBindings(stream.lastLogger)
        const mergingObject = recordFrom(stream.lastObj)

        /**
         * Check both sources independently. A merging object can shadow a child binding in the
         * emitted JSON, but neither form is allowed to disguise Periscope's internal channel: a
         * failed store that becomes another log entry would recurse until the process falls over.
         */
        if (bindings.name === 'periscope.internal' || mergingObject.name === 'periscope.internal') {
          return
        }

        const content: LogEntryContent = {
          level: levelLabel(stream.lastLogger, stream.lastLevel),
          levelNumber: stream.lastLevel,
          message: stream.lastMsg ?? null,
          context: serializeContext(bindings, mergingObject),
          time: metadataTime(stream.lastTime),
        }

        options.recorder.record(IncomingEntry.make(EntryType.LOG, content))
        stats.recorded++
      })
    },
  }

  return stream
}
