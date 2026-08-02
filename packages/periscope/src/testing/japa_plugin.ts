/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { PluginFn } from '@japa/runner/types'

import type { Recorder } from '../recorder/recorder.ts'
import type { StoredEntry } from '../types.ts'
import {
  assertNotRecorded,
  assertRecorded,
  clearRecorded,
  findEntries,
  flushAndWait,
} from './index.ts'
import type { EntriesPredicate, RecordedEntryMatcher, WaitForRecordedOptions } from './index.ts'

export type PeriscopeTestingApi = {
  flushAndWait(
    predicate?: EntriesPredicate,
    options?: WaitForRecordedOptions
  ): Promise<StoredEntry[]>
  findEntries(matcher: RecordedEntryMatcher): Promise<StoredEntry[]>
  assertRecorded(
    matcher: RecordedEntryMatcher,
    options?: WaitForRecordedOptions
  ): Promise<StoredEntry[]>
  assertNotRecorded(matcher: RecordedEntryMatcher, options?: WaitForRecordedOptions): Promise<void>
  clearRecorded(application?: string): Promise<void>
}

export type PeriscopeTestContext = {
  periscope: PeriscopeTestingApi
}

export type PeriscopePluginOptions = WaitForRecordedOptions & {
  recorder: Recorder
  /** Clear recordings before every test. */
  autoClear?: boolean
  /** Default application used by automatic and context-triggered cleanup. */
  application?: string
}

/** Decorate every Japa test context with recorder-bound Periscope testing helpers. */
export function periscopePlugin(options: PeriscopePluginOptions): PluginFn {
  const defaultWaitOptions: WaitForRecordedOptions = {
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs,
  }
  const api: PeriscopeTestingApi = {
    flushAndWait: (predicate, waitOptions) =>
      flushAndWait(options.recorder, predicate, { ...defaultWaitOptions, ...waitOptions }),
    findEntries: (matcher) => findEntries(options.recorder, matcher),
    assertRecorded: (matcher, waitOptions) =>
      assertRecorded(options.recorder, matcher, { ...defaultWaitOptions, ...waitOptions }),
    assertNotRecorded: (matcher, waitOptions) =>
      assertNotRecorded(options.recorder, matcher, { ...defaultWaitOptions, ...waitOptions }),
    clearRecorded: (application = options.application) =>
      clearRecorded(options.recorder, application),
  }

  const decorate = async (test: { context: object }) => {
    if (options.autoClear === true) {
      await clearRecorded(options.recorder, options.application)
    }

    ;(test.context as Record<string, unknown>).periscope = api
  }

  return ({ runner }) => {
    runner.onSuite((suite) => {
      suite.onTest((test) => test.setup(decorate))
      suite.onGroup((group) => group.each.setup(decorate))
    })
  }
}
