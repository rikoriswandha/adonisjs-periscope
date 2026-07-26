/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'

import { safeguard } from '../../safeguard.ts'
import { getActiveWatcher } from '../active.ts'

/**
 * Constructor shape accepted by the mixin. `never[]` parameters keep every concrete exception
 * handler class assignable (constructor parameters are contravariant) without widening to
 * `any`, and `abstract new` additionally admits abstract base handlers.
 */
type ExceptionHandlerConstructor = abstract new (...args: never[]) => {
  report(error: unknown, ctx: HttpContext): unknown
}

/**
 * Add Periscope capture to an application's exception handler without changing how that handler
 * is constructed or what its `report()` returns.
 *
 * The safeguard around the active watcher call is the load-bearing boundary in this module.
 * This override runs on AdonisJS's error path; allowing an observability failure to escape would
 * make the server abandon the application's real reporter and fall back to its emergency 500
 * handler. Capture is therefore best-effort, while delegation to `super` is unconditional.
 */
export function withPeriscope<T extends ExceptionHandlerConstructor>(ExceptionHandler: T): T {
  /**
   * Extending the fixed constructor shape instead of the generic type variable avoids
   * TypeScript's mixin rule, which otherwise requires an `any[]` constructor and would discard
   * the exact constructor type this function promises to preserve.
   */
  const BaseHandler: ExceptionHandlerConstructor = ExceptionHandler
  abstract class PeriscopeExceptionHandler extends BaseHandler {
    override report(error: unknown, ctx: HttpContext): ReturnType<InstanceType<T>['report']> {
      safeguard('periscope.exception.mixin', () => {
        getActiveWatcher('exception')?.report(error, ctx)
      })

      return super.report(error, ctx) as ReturnType<InstanceType<T>['report']>
    }
  }

  return PeriscopeExceptionHandler as unknown as T
}
