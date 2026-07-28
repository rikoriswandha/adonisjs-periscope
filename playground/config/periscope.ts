/*
|--------------------------------------------------------------------------
| Periscope configuration
|--------------------------------------------------------------------------
|
| The fixture app's Periscope config. It is deliberately close to the published stub
| (`packages/periscope/stubs/config/periscope.stub`) so that drift between what an application
| gets from `node ace add @rikology/adonisjs-periscope` and what the playground exercises shows up here first.
|
| `sqlite-local` is the zero-config default, so that is what the fixture runs on: the
| demo command and the functional tests both prove entries survive in `tmp/periscope.sqlite`
| rather than in a ring buffer that dies with the process.
|
*/

import { defineConfig } from '@rikology/adonisjs-periscope/periscope_config'

import { demoQueue } from '../app/periscope/demo_queue_adapter.js'

const benchmarking = process.env.PERISCOPE_BENCH_STORAGE === 'memory'

export default defineConfig({
  enabled: true,

  /**
   * The playground runs under NODE_ENV=development locally and NODE_ENV=test in CI, and both
   * need to record for the watcher demos and the integration tests to mean anything.
   */
  enabledIn: ['development', 'test'],

  storage: {
    /**
     * The shipped default. The benchmark switches only its isolated child process to the
     * bounded memory driver: the gate measures watcher/recorder hot-path overhead without folding
     * host-specific filesystem latency into every run. Storage persistence and failure behavior
     * have separate sqlite and postgres gates.
     */
    driver: benchmarking ? 'memory' : 'sqlite-local',
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
    ambientRotationMs: benchmarking ? 3_600_000 : 2_000,
    pausedFlagTtlMs: benchmarking ? 3_600_000 : 5_000,
  },

  redact: {
    /**
     * Left at the shipped defaults, which already cover the `password` field `POST /echo` sends —
     * that route exists precisely to prove redaction end to end.
     */
    replacement: '[REDACTED]',
  },

  watchers: {
    request: {
      /**
       * Disable this when HTTP traffic is already observed elsewhere and request entries would
       * only duplicate that signal.
       */
      enabled: true,

      /**
       * Lower this to surface latency earlier, or raise it when long-running requests are normal
       * for the application and should not all receive a `slow` tag.
       */
      slowMs: 1_000,

      /**
       * Disable this when response bodies are too sensitive to retain even after redaction, or
       * when serialising previews would add unacceptable work to request completion.
       */
      captureResponse: !benchmarking,

      /**
       * Lower this when response previews consume too much storage, or raise it when the useful
       * part of a large JSON or text response would otherwise be truncated.
       */
      responseSizeLimitKb: 64,

      /**
       * Disable this when session state is too sensitive or noisy to attach to request entries.
       */
      captureSession: !benchmarking,
    },

    query: {
      /**
       * Disable this when database activity is intentionally observed by another tool or query
       * volume is not useful to the investigation.
       */
      enabled: !benchmarking,

      /**
       * Lower this to flag tighter latency regressions, or raise it when expensive queries are
       * expected and should not dominate the `slow` filter. The playground keeps it low so the
       * `/slow` probe clears it by a wide margin even on fast CI hardware.
       */
      slowMs: 25,

      /**
       * Enable this when bound values must never be retained, even after Periscope's recursive
       * redaction has removed recognised secrets.
       */
      hideBindings: false,
    },

    exception: {
      /**
       * Disable this when the application's exception pipeline already records the same failures
       * and duplicate entries would obscure the request batch.
       */
      enabled: !benchmarking,

      /**
       * Use `always` when deployed source is available and production code frames are worth the
       * file reads, or `never` when source context must not be retained.
       */
      captureCodeFrame: 'dev',

      /**
       * Disable this when a process supervisor owns unhandled failures and recording them here
       * would duplicate an existing crash report.
       */
      captureProcessErrors: !benchmarking,
    },

    log: {
      /**
       * Disable this when logs already reach an observability system and copying them into request
       * batches would add noise rather than context.
       */
      enabled: !benchmarking,

      /**
       * Lower this while investigating verbose application behaviour, or raise it when only the
       * most severe records deserve storage alongside a batch.
       */
      level: 'warn',
    },

    event: {
      /**
       * Disable this when application events carry no useful diagnostic context or are already
       * captured by another subscriber.
       */
      enabled: !benchmarking,

      /**
       * Add globs for application event namespaces that are too noisy or sensitive to retain;
       * Periscope already excludes its own and the framework's infrastructure events.
       */
      ignore: [],
    },

    command: {
      /**
       * Periscope commands are always ignored; add application commands here when they are noisy.
       */
      enabled: !benchmarking,
      ignore: [],
    },

    mail: {
      enabled: !benchmarking,
    },

    cache: {
      /**
       * Capture fixture values so the functional test proves recursive redaction on cache entries.
       */
      enabled: !benchmarking,
      captureValues: !benchmarking,
    },

    model: {
      /**
       * Capture the fixture update diff so Lucid's pre-hydration dirty state is exercised.
       */
      enabled: !benchmarking,
      captureDirty: !benchmarking,
    },

    gate: {
      enabled: !benchmarking,
      ignoreAbilities: [],
    },

    dump: {
      enabled: !benchmarking,
    },

    http_client: {
      enabled: !benchmarking,
    },

    /**
     * The opt-in integrations. They subscribe to nothing by default; the playground turns them
     * all on so `/showcase` and the session routes can prove them end-to-end.
     */
    session: {
      enabled: !benchmarking,
      captureValues: !benchmarking,
    },

    redis: {
      enabled: !benchmarking,
      captureArguments: !benchmarking,
    },

    job_schedule: {
      enabled: !benchmarking,
      adapters: [demoQueue.adapter],
      capturePayload: !benchmarking,
    },
  },

  dashboard: {
    /**
     * Change this when `/periscope` conflicts with an application route or the dashboard needs to
     * live beneath a different URL prefix.
     */
    path: '/periscope',
  },
})
