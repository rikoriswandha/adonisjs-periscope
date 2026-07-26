/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { getActiveTest } from '@japa/runner'
import { AppFactory } from '@adonisjs/core/factories/app'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { EmitterFactory } from '@adonisjs/core/factories/events'
import type { Logger } from '@adonisjs/core/logger'
import type { ApplicationService, EmitterService } from '@adonisjs/core/types'

/**
 * Throwaway application root. Nothing is read from disk — `rcContents` and `useConfig` short
 * circuit both the `adonisrc.ts` lookup and the config directory loader — but the app still
 * needs a root URL to resolve `app.makePath()` and friends against.
 */
const BASE_URL = new URL('../tmp/', import.meta.url)

export type CreateAppOptions = {
  /**
   * Application root. Defaults to `tests/tmp/`.
   */
  appRoot?: URL

  /**
   * Adonis process environment. Defaults to the factory's `test` environment.
   */
  environment?: 'web' | 'console' | 'test' | 'repl' | 'unknown'

  /**
   * Config values seeded into `app.config`, merged over the defaults. Watcher tests use this
   * to seed a `periscope` config key.
   */
  config?: Record<string, unknown>

  /**
   * `adonisrc.ts` contents, merged over the defaults. Defaults to no providers, so booting is
   * instant and side-effect free.
   */
  rcContents?: Record<string, unknown>
}

export type TestApp = {
  app: ApplicationService
  emitter: EmitterService
  logger: Logger
}

/**
 * Boots a throwaway AdonisJS application with an in-memory emitter and logger, for unit-level
 * watcher and recorder tests. The emitter is bound into the container, so code under test can
 * resolve it the same way it would in a real application.
 *
 * When called from inside a test, the application is terminated during test cleanup.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<TestApp> {
  const factory = new AppFactory()

  if (options.environment !== undefined) {
    factory.merge({ environment: options.environment })
  }

  const application = factory.create(options.appRoot ?? BASE_URL, () => {})
  const app = application as ApplicationService

  app.rcContents({ providers: [], ...options.rcContents })
  app.useConfig({
    logger: { default: 'main', loggers: { main: {} } },
    ...options.config,
  })

  await app.init()
  await app.boot()

  /**
   * The factory emitter is generically typed (`Emitter<Record<string, any>>`) because it has no
   * application events list to narrow against. Casting it to `EmitterService` is the same
   * unchecked-but-safe step the official @adonisjs packages take in their own tests.
   */
  const emitter = new EmitterFactory().create(app) as unknown as EmitterService
  const logger = new LoggerFactory().create()

  app.container.singleton('emitter', () => emitter)

  getActiveTest()?.cleanup(async () => {
    await app.terminate()
  })

  return { app, emitter, logger }
}
