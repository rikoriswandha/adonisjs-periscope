/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { IncomingEntry } from '../../entry.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard, safeguardAsync } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { ValidationEntryContent, ValidationFieldError } from './types.ts'

const MAX_ERRORS = 50
const MAX_FIELD_TAGS = 5

type FieldContext = {
  getFieldPath(): string
}

type ErrorReporter = {
  hasErrors: boolean
  report(
    message: string,
    rule: string,
    field: FieldContext,
    meta?: Record<string, unknown>
  ): unknown
  createError(): Error
}

type ErrorReporterFactory = () => ErrorReporter

type VineInstance = {
  errorReporter: ErrorReporterFactory
}

/**
 * Records errors collected by VineJS' default validation reporter.
 *
 * Applications that replace `vine.errorReporter` after this watcher registers intentionally opt
 * out of observation. Cleanup will not overwrite such an application-owned replacement.
 */
export class VineWatcher implements Watcher {
  readonly name = WatcherName.VINE
  readonly stats = { recorded: 0, ignored: 0 }

  readonly #context: WatcherContext
  #vine: VineInstance | null = null
  #original: ErrorReporterFactory | null = null
  #wrapper: ErrorReporterFactory | null = null
  #registeringGeneration: number | null = null
  #generation = 0
  #active = false

  constructor(context: WatcherContext) {
    this.#context = context
  }

  async register(): Promise<void> {
    if (
      this.#active ||
      this.#registeringGeneration !== null ||
      !this.#context.config.watchers.vine.enabled
    ) {
      return
    }

    const generation = this.#generation
    this.#registeringGeneration = generation

    await safeguardAsync('periscope.watcher.vine.register', async () => {
      // Vine is an optional peer dependency, so loading it statically would prevent applications
      // without Vine from booting Periscope.
      const module = await import('@vinejs/vine')
      if (generation !== this.#generation) return

      const vine = module.default as unknown as VineInstance
      const original = vine.errorReporter
      if (typeof original !== 'function') return

      const wrapper: ErrorReporterFactory = () => {
        const reporter = original()
        return (
          safeguard(
            'periscope.watcher.vine.wrap_reporter',
            () => this.#wrapReporter(reporter),
            reporter
          ) ?? reporter
        )
      }

      vine.errorReporter = wrapper
      this.#vine = vine
      this.#original = original
      this.#wrapper = wrapper
      this.#active = true
    })

    if (this.#registeringGeneration === generation) this.#registeringGeneration = null
  }

  cleanup(): void {
    this.#generation++
    this.#registeringGeneration = null
    this.#active = false

    const vine = this.#vine
    const original = this.#original
    const wrapper = this.#wrapper
    this.#vine = null
    this.#original = null
    this.#wrapper = null

    if (vine !== null && original !== null && wrapper !== null) {
      safeguard('periscope.watcher.vine.cleanup', () => {
        if (vine.errorReporter === wrapper) vine.errorReporter = original
      })
    }
  }

  #wrapReporter(reporter: ErrorReporter): ErrorReporter {
    const errors: ValidationFieldError[] = []
    let errorCount = 0
    const watcher = this

    return new Proxy(reporter, {
      get(target, property, receiver) {
        if (property === 'report') {
          return function (
            message: string,
            rule: string,
            field: FieldContext,
            meta?: Record<string, unknown>
          ): unknown {
            const result = Reflect.apply(target.report, target, [message, rule, field, meta])

            safeguard('periscope.watcher.vine.report', () => {
              errorCount++
              if (errors.length >= MAX_ERRORS) {
                watcher.stats.ignored++
                return
              }

              errors.push({
                field: field.getFieldPath(),
                rule,
                message,
                ...(meta === undefined ? {} : { meta: safeSerialize(meta) }),
              })
            })

            return result
          }
        }

        if (property === 'createError') {
          return function (): Error {
            // tryValidate catches this same error internally, so both throwing and non-throwing
            // validation paths are observed at this single reporter boundary.
            safeguard('periscope.watcher.vine.create_error', () => {
              if (!watcher.#active || errorCount === 0) return

              const fields = [...new Set(errors.map((error) => error.field))]
              const content: ValidationEntryContent = { errorCount, fields, errors }
              const tags = [
                'validation',
                ...fields.slice(0, MAX_FIELD_TAGS).map((field) => `field:${field}`),
              ]

              watcher.#context.recorder.record(
                IncomingEntry.make(EntryType.VALIDATION, content).withTags(...tags)
              )
              watcher.stats.recorded++
            })

            return Reflect.apply(target.createError, target, [])
          }
        }

        return Reflect.get(target, property, receiver)
      },
    })
  }
}
