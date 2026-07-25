import type { HttpContext } from '@adonisjs/core/http'

import { echoValidator } from '#validators/playground'

export default class EchoController {
  /**
   * `POST /echo` — validates and echoes the payload straight back, password
   * included. Periscope's recorded copy of this request must show
   * `password: '[REDACTED]'` while the HTTP response still carries the real
   * value; that difference is the redaction test.
   */
  async handle({ request }: HttpContext) {
    const payload = await request.validateUsing(echoValidator)
    return { echoed: payload }
  }
}
