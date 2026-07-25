/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Implemented in Phase 3 (P3.4 — ExceptionWatcher). Phase 0 ships the module so the package
 * `exports` map resolves and `npm run build` produces every declared entry point.
 *
 * `withPeriscope` wraps an application's `HttpExceptionHandler` subclass. P3.4 overrides
 * `report()` to record the exception (class name, message, source-mapped stack, dev-only code
 * frame, request summary, `familyHash`) before delegating to `super.report()`. The Phase 0
 * mixin returns the class untouched so an application can adopt the call site now and pick up
 * the behaviour on upgrade — and so a broken mixin can never break error reporting.
 */

/**
 * Constructor shape accepted by the mixin. `never[]` parameters keep every concrete exception
 * handler class assignable (constructor parameters are contravariant) without widening to
 * `any`, and `abstract new` additionally admits abstract base handlers.
 */
type ExceptionHandlerConstructor = abstract new (...args: never[]) => unknown

export function withPeriscope<T extends ExceptionHandlerConstructor>(ExceptionHandler: T): T {
  return ExceptionHandler
}
