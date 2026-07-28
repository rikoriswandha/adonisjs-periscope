import { Exception } from '@adonisjs/core/exceptions'

/**
 * Thrown by `GET /boom`. It is a real 5xx exception (not a 4xx short-circuit)
 * so the framework's exception handler both *reports* it and renders a 500 —
 * which is what Periscope's ExceptionWatcher hangs off.
 */
export default class BoomException extends Exception {
  static status = 500
  static code = 'E_BOOM'
}
