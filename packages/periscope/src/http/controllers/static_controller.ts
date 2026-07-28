/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { HttpContext } from '@adonisjs/core/http'

const HASHED_ASSET = /(?:^|[.-])[a-zA-Z0-9_-]{8,}\.[^.]+$/
const DEFAULT_DASHBOARD_ROOT = fileURLToPath(new URL('../../../dashboard/', import.meta.url))

export type StaticControllerOptions = {
  dashboardPath: string
  dashboardRoot?: string
}

/**
 * Resolve a catch-all route parameter beneath one directory. Both URL and Windows separators are
 * normalized before rejecting dot segments and Windows-ambiguous trailing dots or spaces. The
 * final relative-path check is the backstop against encoded or platform-specific traversal.
 */
export function resolveStaticPath(root: string, value: unknown): string | null {
  const raw = Array.isArray(value) ? value.join('/') : typeof value === 'string' ? value : ''
  let decoded: string

  try {
    decoded = decodeURIComponent(raw).replaceAll('\\', '/')
  } catch {
    return null
  }

  if (decoded === '' || decoded.includes('\0')) {
    return null
  }

  const segments = decoded.split('/')

  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.') ||
        segment.endsWith(' ')
    )
  ) {
    return null
  }

  const absoluteRoot = resolve(root)
  const candidate = resolve(absoluteRoot, ...segments)
  const withinRoot = relative(absoluteRoot, candidate)

  if (
    withinRoot === '' ||
    withinRoot === '..' ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot)
  ) {
    return null
  }

  return candidate
}

export class StaticController {
  readonly #dashboardPath: string
  readonly #dashboardRoot: string

  constructor(options: StaticControllerOptions) {
    this.#dashboardPath = options.dashboardPath
    this.#dashboardRoot = options.dashboardRoot ?? DEFAULT_DASHBOARD_ROOT
  }

  root({ request, response }: HttpContext) {
    if (this.#dashboardPath !== '/' && !request.url().endsWith('/')) {
      response.redirect(`${this.#dashboardPath}/`, true)
      return
    }

    this.#sendIndex(response)
  }

  /**
   * The SPA is built with `base: './'`, so a hard refresh on a nested route
   * (e.g. `/requests/:id`) makes the browser request `.../requests/assets/*`.
   * Serve anything under an `assets/` segment as an asset instead of falling
   * back to index.html, which would break strict MIME checking.
   */
  spa({ params, response }: HttpContext) {
    const wildcard = params['*']
    const segments = Array.isArray(wildcard) ? wildcard : String(wildcard ?? '').split('/')
    const assetsIndex = segments.lastIndexOf('assets')

    if (assetsIndex !== -1 && assetsIndex < segments.length - 1) {
      this.#sendAsset(response, segments.slice(assetsIndex + 1).join('/'))
      return
    }

    this.#sendIndex(response)
  }

  asset({ params, response }: HttpContext) {
    const wildcard = params['*']
    this.#sendAsset(response, Array.isArray(wildcard) ? wildcard.join('/') : wildcard)
  }

  #sendAsset(response: HttpContext['response'], relativePath: unknown) {
    const asset = resolveStaticPath(resolve(this.#dashboardRoot, 'assets'), relativePath)

    if (asset === null) {
      response.notFound()
      return
    }

    const cacheControl = HASHED_ASSET.test(basename(asset))
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
    response.download(asset, true, () => ['Not found', 404])
    response.header('Cache-Control', cacheControl)
  }

  #sendIndex(response: HttpContext['response']) {
    response.download(resolve(this.#dashboardRoot, 'index.html'), true, () => ['Not found', 404])
    response.header('Cache-Control', 'no-cache')
  }
}
