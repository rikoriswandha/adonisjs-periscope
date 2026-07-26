import { Bouncer } from '@adonisjs/bouncer'

import type User from '#models/user'

export const inspectWave2Ability = Bouncer.ability(function inspectWave2(
  user: User,
  resource: { ownerId: number; password: string }
) {
  return user.id === resource.ownerId
})
