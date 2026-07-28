/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import app from '@adonisjs/core/services/app'

import { Recorder } from './recorder.ts'

/**
 * The container service behind the `@rikology/adonisjs-periscope/services/recorder` subpath.
 *
 * ```ts
 * import recorder from '@rikology/adonisjs-periscope/services/recorder'
 * import { EntryType, IncomingEntry } from '@rikology/adonisjs-periscope'
 *
 * recorder.record(IncomingEntry.make(EntryType.EVENT, { name: 'order.placed' }))
 * ```
 *
 * Both names come from the package root rather than `periscope/types`: they are used here as
 * *values*, and `periscope/types` exports `IncomingEntry` as a type only — copy-pasting an
 * import from there fails at runtime with "does not provide an export named 'IncomingEntry'".
 *
 * Resolving the singleton requires `PeriscopeProvider` to be registered in `adonisrc.ts` — the
 * provider is what binds the class, wiring in the resolved config and the storage driver. Import
 * this module without it and the container will hand back an unconfigured instance.
 *
 * Same shape as the official `@adonisjs/lucid` and `@adonisjs/mail` services: a top-level await on
 * `app.booted()` so the singleton is resolved exactly once, after providers have registered.
 */
let recorder: Recorder

await app.booted(async () => {
  recorder = await app.container.make(Recorder)
})

export { recorder as default }
