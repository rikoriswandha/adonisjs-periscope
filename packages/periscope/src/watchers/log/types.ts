/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { LoggerConfig } from '@adonisjs/logger/types'

import type { Recorder } from '../../recorder/recorder.ts'
import type { LogLevelName } from '../../types.ts'

/**
 * The payload stored for a pino record.
 *
 * `time` is kept in the form selected by the application's logger: pino's epoch timestamp is a
 * number, while its ISO timestamp is a string. A logger may turn timestamps off entirely, in
 * which case the field is `null` rather than an invented time that disagrees with the line the
 * application emitted.
 */
export type LogEntryContent = {
  level: string
  levelNumber: number
  message: string | null
  context: Record<string, unknown>
  time: number | string | null
}

/**
 * A deliberately tiny health signal shared by the watcher and its stream. Counting after a line
 * has passed the level and self-channel filters makes this describe records handed to the
 * recorder, not merely writes pino attempted.
 */
export type LogWatcherStats = {
  recorded: number
}

/**
 * Options for the public stream escape hatch. Applications that construct pino instances outside
 * AdonisJS's logger manager can pass the returned stream as their destination or a multistream
 * branch and still use the same recorder and threshold as the built-in watcher.
 */
export type PeriscopeLogStreamOptions = {
  recorder: Recorder
  level: LogLevelName
}

/**
 * The destination shape pino writes to, plus the metadata slots it fills immediately before
 * `write()`. Deriving the destination from AdonisJS's logger config keeps pino an implementation
 * dependency of `@adonisjs/logger`; Periscope does not need to add or version it independently.
 */
export type PeriscopeLogStream = NonNullable<LoggerConfig['destination']> & {
  lastLevel: number
  lastTime: string
  lastMsg: string | undefined
  lastObj: unknown
  lastLogger: unknown
  readonly stats: LogWatcherStats
}
