import hash from '@adonisjs/core/services/hash'
import type { HttpContext } from '@adonisjs/core/http'

import User from '#models/user'
import { loginValidator } from '#validators/playground'

/**
 * The plan's "auth-less login stub": no `@adonisjs/auth`, just a user id parked
 * in the session. Enough to give the future RequestWatcher a session snapshot
 * and an authenticated-looking batch to tag.
 */
export default class SessionController {
  /**
   * `POST /login` — finds or creates the user, then writes its id to the session.
   */
  async login({ request, response, session }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)

    let user = await User.findBy('email', email)

    if (user) {
      if (!(await hash.verify(user.password, password))) {
        return response.unauthorized({ error: 'Invalid credentials' })
      }
    } else {
      user = await User.create({
        email,
        fullName: null,
        password: await hash.make(password),
      })
    }

    session.put('userId', user.id)

    return { userId: user.id, email: user.email }
  }

  /**
   * `GET /me` — reads the id back out of the session.
   */
  async me({ response, session }: HttpContext) {
    const userId = session.get('userId')

    if (!userId) {
      return response.unauthorized({ error: 'Not logged in' })
    }

    return { userId }
  }
}
