/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { BaseCommand, Kernel } from '@adonisjs/core/ace'

import { IncomingEntry } from '../../entry.ts'
import { BatchScope } from '../../recorder/context.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard, safeguardAsync } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { CommandEntryContent } from './types.ts'

type CommandInstance = InstanceType<typeof BaseCommand>
type CommandExec = (...args: unknown[]) => unknown

type InstancePatch = {
  originalDescriptor: PropertyDescriptor | undefined
  wrapper: CommandExec
}

/**
 * Records Ace command executions as their own batches.
 *
 * Ace 14 executing hooks are permanent. Therefore the installed hook only delegates while this
 * watcher is active, and cleanup also restores any command instance whose `exec` method is still
 * patched. Periscope commands are patched too, but only to mute their complete execution: they
 * must be able to manage the store without recording the reads and writes they perform.
 */
export class CommandWatcher implements Watcher {
  readonly name = WatcherName.COMMAND
  readonly stats = { recorded: 0, ignored: 0 }

  readonly #context: WatcherContext
  readonly #ignoredCommands: Set<string>
  readonly #patches = new Map<CommandInstance, InstancePatch>()

  #active = false
  #hookInstalled = false
  #installing: Promise<void> | null = null

  constructor(context: WatcherContext) {
    this.#context = context
    this.#ignoredCommands = new Set(context.config.watchers.command.ignore)
  }

  /**
   * Resolve Ace only in console applications and install its executing hook once.
   */
  async register(): Promise<void> {
    if (this.#context.app.getEnvironment() !== 'console') {
      return
    }

    this.#active = true

    if (this.#hookInstalled) {
      return
    }

    if (this.#installing === null) {
      this.#installing = this.#installHook()
    }

    const installing = this.#installing
    await installing

    if (this.#installing === installing) {
      this.#installing = null
    }
  }

  /**
   * Make the permanent Ace hook inert and restore all instance-level patches still in flight.
   */
  cleanup(): void {
    this.#active = false

    for (const [command, patch] of this.#patches) {
      safeguard('periscope.watcher.command.restore', () => this.#restore(command, patch))
    }
  }

  async #installHook(): Promise<void> {
    const installed = await safeguardAsync(
      'periscope.watcher.command.subscribe',
      async () => {
        const kernel: Kernel = await this.#context.app.container.make('ace')
        kernel.executing(this.#handleExecuting)
        return true
      },
      false
    )

    if (installed === true) {
      this.#hookInstalled = true
    }
  }

  readonly #handleExecuting = (command: CommandInstance, isMain: boolean): void => {
    if (!this.#active) {
      return
    }

    safeguard('periscope.watcher.command.patch', () => this.#patch(command, isMain))
  }

  #patch(command: CommandInstance, isMain: boolean): void {
    if (this.#patches.has(command)) {
      return
    }

    const commandName = command.commandName

    if (commandName.startsWith('periscope:')) {
      this.stats.ignored++
      this.#patchMuted(command)
      return
    }

    if (this.#ignoredCommands.has(commandName)) {
      this.stats.ignored++
      return
    }

    this.#patchRecorded(command, commandName, isMain)
  }

  #patchMuted(command: CommandInstance): void {
    const original = Reflect.get(command, 'exec')
    if (typeof original !== 'function') {
      return
    }

    const watcher = this
    let patch!: InstancePatch
    const wrapper: CommandExec = function (this: CommandInstance, ...args: unknown[]): unknown {
      let executionStarted = false

      try {
        return BatchScope.mute(() => {
          executionStarted = true
          return Reflect.apply(original, this, args)
        })
      } catch (error) {
        if (executionStarted) {
          throw error
        }

        safeguard('periscope.watcher.command.mute', () => {
          throw error
        })
        return Reflect.apply(original, this, args)
      } finally {
        safeguard('periscope.watcher.command.restore', () => watcher.#restore(command, patch))
      }
    }

    patch = this.#installPatch(command, wrapper)
  }

  #patchRecorded(command: CommandInstance, commandName: string, isMain: boolean): void {
    const original = Reflect.get(command, 'exec')
    if (typeof original !== 'function') {
      return
    }

    const watcher = this
    let patch!: InstancePatch
    const wrapper: CommandExec = async function (
      this: CommandInstance,
      ...args: unknown[]
    ): Promise<unknown> {
      const batch = safeguard(
        'periscope.watcher.command.open',
        () => BatchScope.createContext('command'),
        null
      )
      if (batch === null || batch === undefined) {
        try {
          return await Reflect.apply(original, this, args)
        } finally {
          safeguard('periscope.watcher.command.restore', () => watcher.#restore(command, patch))
        }
      }

      const startedAt = process.hrtime.bigint()
      let executionStarted = false
      let didThrow = false
      let thrown: unknown

      try {
        return await BatchScope.runWith(batch, async () => {
          executionStarted = true

          try {
            return await Reflect.apply(original, this, args)
          } catch (error) {
            didThrow = true
            thrown = error
            throw error
          } finally {
            safeguard('periscope.watcher.command.record', () =>
              watcher.#record(command, commandName, isMain, startedAt, didThrow, thrown)
            )
            await safeguardAsync('periscope.watcher.command.flush', () =>
              watcher.#context.recorder.flush(batch)
            )
          }
        })
      } catch (error) {
        if (executionStarted) {
          throw error
        }

        safeguard('periscope.watcher.command.scope', () => {
          throw error
        })
        return await Reflect.apply(original, this, args)
      } finally {
        safeguard('periscope.watcher.command.restore', () => watcher.#restore(command, patch))
      }
    }

    patch = this.#installPatch(command, wrapper)
  }

  #installPatch(command: CommandInstance, wrapper: CommandExec): InstancePatch {
    const patch: InstancePatch = {
      originalDescriptor: Object.getOwnPropertyDescriptor(command, 'exec'),
      wrapper,
    }

    const installed = Reflect.defineProperty(command, 'exec', {
      configurable: true,
      enumerable: patch.originalDescriptor?.enumerable ?? false,
      writable: true,
      value: wrapper,
    })

    if (!installed) {
      throw new TypeError(`Unable to wrap Ace command "${command.commandName}"`)
    }

    this.#patches.set(command, patch)
    return patch
  }

  #restore(command: CommandInstance, patch: InstancePatch): void {
    if (this.#patches.get(command) !== patch) {
      return
    }

    this.#patches.delete(command)

    if (Reflect.get(command, 'exec') !== patch.wrapper) {
      return
    }

    const restored =
      patch.originalDescriptor === undefined
        ? Reflect.deleteProperty(command, 'exec')
        : Reflect.defineProperty(command, 'exec', patch.originalDescriptor)

    if (!restored) {
      throw new TypeError(`Unable to restore Ace command "${command.commandName}"`)
    }
  }

  #record(
    command: CommandInstance,
    commandName: string,
    isMain: boolean,
    startedAt: bigint,
    didThrow: boolean,
    thrown: unknown
  ): void {
    const snapshot = command.toJSON()
    const snapshotError = snapshot.error
    const hasError = didThrow || snapshotError !== undefined
    const exitCode =
      typeof snapshot.exitCode === 'number' && Number.isFinite(snapshot.exitCode)
        ? snapshot.exitCode
        : hasError
          ? 1
          : 0
    const content: CommandEntryContent = {
      command: commandName,
      args: safeSerialize(snapshot.args),
      flags: safeSerialize(snapshot.flags),
      isMain,
      exitCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      ...(hasError ? { error: safeSerialize(didThrow ? thrown : snapshotError) } : {}),
    }

    this.#context.recorder.record(
      IncomingEntry.make(EntryType.COMMAND, content).withTags(
        `command:${commandName}`,
        `exit:${exitCode}`,
        isMain ? 'main' : 'nested'
      )
    )
    this.stats.recorded++
  }
}
