/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { IncomingEntry } from '../../entry.ts'
import { safeSerialize } from '../../recorder/serializer.ts'
import { safeguard } from '../../safeguard.ts'
import { EntryType, WatcherName } from '../../types.ts'
import type { Watcher } from '../../types.ts'
import type { WatcherContext } from '../context.ts'
import type { ModelEntryContent } from './types.ts'

type ModelAction = ModelEntryContent['action']

type ModelInstance = {
  constructor: LucidModel
  $attributes: unknown
  $dirty: unknown
  $primaryKeyValue: unknown
}

type ModelHook = (model: ModelInstance) => void

type LucidModel = {
  readonly name: string
  primaryKey?: unknown
  boot(): unknown
  before(event: 'update', hook: ModelHook): void
  after(event: ModelAction, hook: ModelHook): void
}

type LucidBaseModel = LucidModel & {
  new (): ModelInstance
  prototype: ModelInstance
}

type BootPatch = {
  baseModel: LucidBaseModel
  descriptor: PropertyDescriptor
  wrapper: (this: LucidModel) => unknown
}

/**
 * Missing Lucid is the one supported no-op. An installed but broken or incompatible Lucid must
 * still surface its import error so the watcher registry can report it instead of silently
 * pretending model observation is active.
 */
function isMissingLucid(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND' &&
    'message' in error &&
    typeof error.message === 'string' &&
    /Cannot find package ['"]@adonisjs\/lucid['"]/.test(error.message)
  )
}

function isLucidBaseModel(value: unknown): value is LucidBaseModel {
  return (
    typeof value === 'function' &&
    'boot' in value &&
    typeof value.boot === 'function' &&
    'before' in value &&
    typeof value.before === 'function' &&
    'after' in value &&
    typeof value.after === 'function'
  )
}

async function loadBaseModel(): Promise<LucidBaseModel | undefined> {
  let lucid: unknown

  try {
    // Lucid is an optional peer, so a static import would make Periscope unloadable without it.
    lucid = await import('@adonisjs/lucid/orm')
  } catch (error) {
    if (isMissingLucid(error)) {
      return undefined
    }

    throw error
  }

  const baseModel =
    lucid !== null && typeof lucid === 'object' && 'BaseModel' in lucid
      ? lucid.BaseModel
      : undefined
  if (!isLucidBaseModel(baseModel)) {
    throw new TypeError('@adonisjs/lucid/orm does not export a compatible BaseModel')
  }

  return baseModel
}

/**
 * Observes Lucid instance persistence without owning any application hooks.
 *
 * Lucid has no global model lifecycle emitter. Every model does, however, pass through the
 * inherited `BaseModel.boot` method. The reversible wrapper below uses that seam to attach the
 * same four callback identities to each model. Lucid stores callbacks in Sets and clones those
 * Sets when hooks are inherited, so using stable identities also prevents an instrumented base
 * class and its child from producing duplicate entries.
 */
export class ModelWatcher implements Watcher {
  readonly name = WatcherName.MODEL

  readonly #context: WatcherContext
  readonly #instrumentedModels = new WeakSet<LucidModel>()
  readonly #dirtySnapshots = new WeakMap<ModelInstance, unknown>()
  #patch?: BootPatch
  #active = false

  constructor(context: WatcherContext) {
    this.#context = context
  }

  /** Capture dirty attributes before Lucid hydrates `$original` ahead of `after:update`. */
  readonly #beforeUpdate: ModelHook = (model) => {
    if (!this.#active || !this.#context.config.watchers.model.captureDirty) {
      return
    }

    safeguard('periscope.watcher.model.dirty', () => {
      this.#dirtySnapshots.set(model, safeSerialize(model.$dirty))
    })
  }

  readonly #afterCreate: ModelHook = (model) => {
    this.#handle('create', model)
  }

  readonly #afterUpdate: ModelHook = (model) => {
    if (!this.#active) {
      return
    }

    const dirty = this.#dirtySnapshots.get(model)
    this.#dirtySnapshots.delete(model)
    this.#handle('update', model, dirty)
  }

  readonly #afterDelete: ModelHook = (model) => {
    this.#handle('delete', model)
  }

  async register(): Promise<void> {
    if (this.#active || this.#patch !== undefined) {
      return
    }

    const baseModel = await loadBaseModel()
    if (baseModel === undefined) {
      return
    }

    const descriptor = Object.getOwnPropertyDescriptor(baseModel, 'boot')
    if (descriptor === undefined || typeof descriptor.value !== 'function') {
      throw new TypeError('@adonisjs/lucid BaseModel.boot is not an own data method')
    }

    const originalBoot = descriptor.value as (this: LucidModel) => unknown
    const watcher = this
    const wrapper = function wrappedPeriscopeModelBoot(this: LucidModel): unknown {
      const result = Reflect.apply(originalBoot, this, [])

      if (this !== baseModel) {
        safeguard('periscope.watcher.model.attach', () => watcher.#attach(this))
      }

      return result
    }

    this.#active = true
    try {
      Object.defineProperty(baseModel, 'boot', { ...descriptor, value: wrapper })
      this.#patch = { baseModel, descriptor, wrapper }
    } catch (error) {
      this.#active = false
      throw error
    }
  }

  /**
   * Stop callbacks first, then restore only the wrapper this watcher installed. Hook collections
   * remain application-owned: attached callbacks cannot be removed through Lucid's public API and
   * are therefore deliberately left in place as inert functions.
   */
  cleanup(): void {
    this.#active = false

    const patch = this.#patch
    this.#patch = undefined
    if (patch === undefined) {
      return
    }

    if (patch.baseModel.boot === patch.wrapper) {
      Object.defineProperty(patch.baseModel, 'boot', patch.descriptor)
    }
  }

  #attach(model: LucidModel): void {
    if (!this.#active || this.#instrumentedModels.has(model)) {
      return
    }

    /** Mark first: a hostile overridden registration method must never cause duplicate retries. */
    this.#instrumentedModels.add(model)
    model.before('update', this.#beforeUpdate)
    model.after('create', this.#afterCreate)
    model.after('update', this.#afterUpdate)
    model.after('delete', this.#afterDelete)
  }

  #handle(action: ModelAction, model: ModelInstance, dirty?: unknown): void {
    if (!this.#active) {
      return
    }

    safeguard(`periscope.watcher.model.${action}`, () => this.#record(action, model, dirty))
  }

  #record(action: ModelAction, instance: ModelInstance, dirty?: unknown): void {
    const model = instance.constructor
    const modelName = model.name || 'AnonymousModel'
    const primaryKey = typeof model.primaryKey === 'string' ? model.primaryKey : undefined
    const primaryKeyValue = instance.$primaryKeyValue

    const content: ModelEntryContent = {
      action,
      model: modelName,
      ...(primaryKey === undefined ? {} : { primaryKey }),
      ...(primaryKeyValue === undefined ? {} : { primaryKeyValue: safeSerialize(primaryKeyValue) }),
      attributes: safeSerialize(instance.$attributes),
      ...(dirty === undefined ? {} : { dirty }),
    }

    this.#context.recorder.record(
      IncomingEntry.make(EntryType.MODEL, content).withTags(
        `model:${modelName}`,
        `action:${action}`
      )
    )
  }
}
