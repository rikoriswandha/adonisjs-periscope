import vine from '@vinejs/vine'

/**
 * `POST /echo` payload. The `password` field is the whole point: Periscope's
 * redactor must replace it with "[REDACTED]" before the request entry is
 * buffered, while `email` and `note` must survive untouched.
 */
export const echoValidator = vine.create({
  email: vine.string().email().maxLength(254),
  password: vine.string().minLength(1).maxLength(64),
  note: vine.string().maxLength(280).optional(),
})

/**
 * `POST /login` payload for the auth-less session stub.
 */
export const loginValidator = vine.create({
  email: vine.string().email().maxLength(254),
  password: vine.string().minLength(1).maxLength(64),
})
