import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import { withPeriscope } from 'periscope/exception_reporter'

class HttpExceptionHandler extends ExceptionHandler {
  /**
   * In debug mode, the exception handler will display verbose errors
   * with pretty printed stack traces.
   */
  protected debug = !app.inProduction

  /**
   * The method is used for handling errors and returning
   * response to the client
   */
  async handle(error: unknown, ctx: HttpContext) {
    return super.handle(error, ctx)
  }

  /**
   * The method is used to report error to the logging service or
   * the a third party error monitoring service.
   *
   * @note You should not attempt to send a response from this method.
   */
  async report(error: unknown, ctx: HttpContext) {
    return super.report(error, ctx)
  }
}

/**
 * The mixin reports an exception to the active watcher before delegating to this handler's
 * existing `report()` implementation. Its active-watcher lookup is inert when Periscope is
 * disabled, so the application's error path and response handling remain unchanged when off.
 */
export default withPeriscope(HttpExceptionHandler)
