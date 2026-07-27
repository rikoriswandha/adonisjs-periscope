import { tracingChannel, type ChannelListener } from 'node:diagnostics_channel'

import { IncomingEntry } from '../../entry.ts'
import { BatchScope } from '../../recorder/context.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { BatchContext, Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { RedisEntryContent } from './types.ts'

type RedisCommand = object & {
  name?: unknown
  args?: unknown
}

type RedisTraceData = {
  command?: RedisCommand
  error?: unknown
}

type CommandState = {
  context?: BatchContext
  startedAt: bigint
}

const redisCommand = tracingChannel<'adonisjs.redis.command', RedisTraceData>(
  'adonisjs.redis.command'
)
const SENSITIVE_COMMANDS = new Set(['auth'])

function commandName(command: RedisCommand): string {
  return typeof command.name === 'string' && command.name !== ''
    ? command.name.toLowerCase()
    : 'unknown'
}

function commandArguments(command: RedisCommand): unknown[] {
  return Array.isArray(command.args) ? command.args : []
}

/** Observes the tracing channel published by @adonisjs/redis without opening a Redis connection. */
export class RedisWatcher implements Watcher {
  readonly name = WatcherName.REDIS
  readonly stats = { recorded: 0 }

  readonly #context: WatcherContext
  readonly #states = new WeakMap<RedisCommand, CommandState>()
  #registered = false

  constructor(context: WatcherContext) {
    this.#context = context
  }

  readonly #start: ChannelListener = (message) => {
    safeguard('periscope.watcher.redis.start', () => {
      const command = (message as RedisTraceData).command
      if (command === undefined) return
      this.#states.set(command, {
        context: BatchScope.current(),
        startedAt: process.hrtime.bigint(),
      })
    })
  }

  readonly #end: ChannelListener = (message) => {
    safeguard('periscope.watcher.redis.end', () => this.#finish(message as RedisTraceData))
  }

  readonly #error: ChannelListener = (message) => {
    safeguard('periscope.watcher.redis.error', () => this.#finish(message as RedisTraceData))
  }

  register(): void {
    if (this.#registered) return
    redisCommand.start.subscribe(this.#start)
    redisCommand.end.subscribe(this.#end)
    redisCommand.error.subscribe(this.#error)
    this.#registered = true
  }

  cleanup(): void {
    if (!this.#registered) return
    redisCommand.start.unsubscribe(this.#start)
    redisCommand.end.unsubscribe(this.#end)
    redisCommand.error.unsubscribe(this.#error)
    this.#registered = false
  }

  #finish(message: RedisTraceData): void {
    const command = message.command
    if (command === undefined) return
    const state = this.#states.get(command)
    if (state === undefined) return
    this.#states.delete(command)

    const name = commandName(command)
    const args = commandArguments(command)
    const captureArguments = this.#context.config.watchers.redis.captureArguments
    const content: RedisEntryContent = {
      command: name,
      argumentCount: args.length,
      durationMs: Number(process.hrtime.bigint() - state.startedAt) / 1_000_000,
      ...(captureArguments
        ? {
            arguments: SENSITIVE_COMMANDS.has(name)
              ? args.map(() => this.#context.config.redact.replacement)
              : safeSerialize(args),
          }
        : {}),
      ...(message.error === undefined ? {} : { error: safeSerialize(message.error) }),
    }
    const record = () => {
      this.#context.recorder.record(
        IncomingEntry.make(EntryType.REDIS, content).withTags(
          `command:${name}`,
          message.error === undefined ? undefined : 'failed'
        )
      )
      this.stats.recorded += 1
    }

    if (state.context === undefined) record()
    else BatchScope.runWith(state.context, record)
  }
}
