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
import type { ViewEntryContent } from './types.ts'

const EDGE_PACKAGE = 'edge.js'
const TEMPLATE_MAX_BYTES = 2 * 1024
const DATA_KEYS_MAX_BYTES = 8 * 1024

type RenderData = Record<string, unknown>
type RenderObserver = (template: unknown, data: unknown, durationMs: number) => void

type EdgeRendererLike = object & {
  render(template: string, data?: RenderData): Promise<string>
  renderSync(template: string, data?: RenderData): string
}

type EdgeLike = object & {
  onRender(callback: (renderer: unknown) => void): unknown
}

type EdgeHookState = {
  observers: Set<RenderObserver>
}

type EdgeLoader = () => Promise<EdgeLike | undefined>

/** One official Edge hook per singleton, even when a watcher is stopped and registered again. */
const edgeHooks = new WeakMap<EdgeLike, EdgeHookState>()
const instrumentedRenderers = new WeakSet<EdgeRendererLike>()

function isMissingEdge(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND' &&
    'message' in error &&
    typeof error.message === 'string' &&
    /Cannot find (?:package|module) ['"]edge\.js['"]/.test(error.message)
  )
}

function isEdge(value: unknown): value is EdgeLike {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'onRender' in value &&
    typeof value.onRender === 'function'
  )
}

function isRenderer(value: unknown): value is EdgeRendererLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    'render' in value &&
    typeof value.render === 'function' &&
    'renderSync' in value &&
    typeof value.renderSync === 'function'
  )
}

async function loadEdge(): Promise<EdgeLike | undefined> {
  let edgeModule: unknown

  try {
    // Edge is optional. Keeping the package name in a variable also avoids a hard type dependency.
    edgeModule = await import(EDGE_PACKAGE)
  } catch (error) {
    if (isMissingEdge(error)) {
      return undefined
    }
    throw error
  }

  const edge =
    edgeModule !== null && typeof edgeModule === 'object' && 'default' in edgeModule
      ? edgeModule.default
      : undefined
  if (!isEdge(edge)) {
    throw new TypeError('edge.js does not export a compatible renderer singleton')
  }

  return edge
}

function dispatch(hook: EdgeHookState, template: unknown, data: unknown, startedAt: bigint): void {
  if (hook.observers.size === 0) return

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
  for (const observer of hook.observers) {
    safeguard('periscope.watcher.view.observe', () => observer(template, data, durationMs))
  }
}

/** Wrap a request-local renderer exactly once while preserving its receiver and rejection shape. */
function instrumentRenderer(renderer: EdgeRendererLike, hook: EdgeHookState): void {
  if (instrumentedRenderers.has(renderer)) return

  const originalRender = renderer.render
  const originalRenderSync = renderer.renderSync

  const wrappedRender = async function periscopeViewRender(
    this: EdgeRendererLike,
    template: string,
    data?: RenderData
  ): Promise<string> {
    const startedAt = process.hrtime.bigint()
    try {
      return await Reflect.apply(originalRender, this, [template, data])
    } finally {
      dispatch(hook, template, data, startedAt)
    }
  }

  const wrappedRenderSync = function periscopeViewRenderSync(
    this: EdgeRendererLike,
    template: string,
    data?: RenderData
  ): string {
    const startedAt = process.hrtime.bigint()
    try {
      return Reflect.apply(originalRenderSync, this, [template, data])
    } finally {
      dispatch(hook, template, data, startedAt)
    }
  }

  renderer.render = wrappedRender
  try {
    renderer.renderSync = wrappedRenderSync
  } catch (error) {
    if (renderer.render === wrappedRender) renderer.render = originalRender
    throw error
  }
  instrumentedRenderers.add(renderer)
}

function observeEdge(edge: EdgeLike, observer: RenderObserver): () => void {
  let hook = edgeHooks.get(edge)
  if (hook === undefined) {
    hook = { observers: new Set() }
    const installedHook = hook
    edge.onRender((renderer) => {
      if (installedHook.observers.size === 0) return
      safeguard('periscope.watcher.view.instrument', () => {
        if (isRenderer(renderer)) instrumentRenderer(renderer, installedHook)
      })
    })
    edgeHooks.set(edge, hook)
  }

  hook.observers.add(observer)
  return () => hook?.observers.delete(observer)
}

function serializedTemplate(template: unknown): string {
  if (typeof template !== 'string') return '[Unknown template]'
  const value = safeSerialize(template, { maxBytes: TEMPLATE_MAX_BYTES })
  return typeof value === 'string' ? value : '[Unknown template]'
}

function serializedDataKeys(data: unknown): string[] {
  if (data === null || (typeof data !== 'object' && typeof data !== 'function')) return []

  const keys = safeguard('periscope.watcher.view.data_keys', () => Object.keys(data), []) ?? []
  const value = safeSerialize(keys, { maxDepth: 1, maxBytes: DATA_KEYS_MAX_BYTES })
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []
}

/** Records Edge template names, timing, and optionally top-level data keys—never render values. */
export class ViewWatcher implements Watcher {
  readonly name = WatcherName.VIEW
  readonly stats = { recorded: 0 }

  readonly #context: WatcherContext
  readonly #loadEdge: EdgeLoader
  #generation = 0
  #registered = false
  #unsubscribe?: () => void

  constructor(context: WatcherContext, edgeLoader: EdgeLoader = loadEdge) {
    this.#context = context
    this.#loadEdge = edgeLoader
  }

  readonly #observer: RenderObserver = (template, data, durationMs) => {
    const safeTemplate = this.#context.recorder.redactor.redact(serializedTemplate(template))
    const content: ViewEntryContent = {
      template: safeTemplate,
      durationMs,
      ...(this.#context.config.watchers.view.captureDataKeys
        ? { dataKeys: serializedDataKeys(data) }
        : {}),
    }

    this.#context.recorder.record(
      IncomingEntry.make(EntryType.VIEW, safeSerialize(content) as ViewEntryContent).withTags(
        safeTemplate
      )
    )
    this.stats.recorded++
  }

  async register(): Promise<void> {
    if (this.#registered) return

    this.#registered = true
    const generation = ++this.#generation
    const edge = await this.#loadEdge()
    if (!this.#registered || generation !== this.#generation || edge === undefined) return

    try {
      this.#unsubscribe = observeEdge(edge, this.#observer)
    } catch (error) {
      this.#registered = false
      throw error
    }
  }

  cleanup(): void {
    this.#registered = false
    this.#generation++
    const unsubscribe = this.#unsubscribe
    this.#unsubscribe = undefined
    unsubscribe?.()
  }
}
