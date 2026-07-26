/*
|--------------------------------------------------------------------------
| Periscope configuration
|--------------------------------------------------------------------------
|
| The fixture app's Periscope config. It is deliberately close to the published stub
| (`packages/periscope/stubs/config/periscope.stub`) so that drift between what an application
| gets from `node ace add periscope` and what the playground exercises shows up here first.
|
| Phase 2 makes `sqlite-local` the zero-config default, so that is what the fixture runs on: the
| demo command and the functional tests both prove entries survive in `tmp/periscope.sqlite`
| rather than in a ring buffer that dies with the process.
|
*/

import { defineConfig } from 'periscope/periscope_config'

export default defineConfig({
  enabled: true,

  /**
   * The playground runs under NODE_ENV=development locally and NODE_ENV=test in CI, and both
   * need to record for the phase demos and the integration tests to mean anything.
   */
  enabledIn: ['development', 'test'],

  storage: {
    /**
     * The shipped default. Everything Periscope records here lands in `tmp/periscope.sqlite`,
     * which is git-ignored and safe to delete — `node ace periscope:demo` prints the resolved
     * path so the file can be queried with `sqlite3` directly.
     */
    driver: 'sqlite-local',
    maxEntries: 10_000,
  },

  recording: {
    caps: {
      default: 100,
      query: 200,
    },

    /**
     * Short enough that the demo command sees the ambient batch rotate without waiting around.
     */
    ambientRotationMs: 2_000,
    pausedFlagTtlMs: 5_000,
  },

  redact: {
    /**
     * Left at the shipped defaults, which already cover the `password` field `POST /echo` sends —
     * that route exists precisely to prove redaction end to end.
     */
    replacement: '[REDACTED]',
  },
})
