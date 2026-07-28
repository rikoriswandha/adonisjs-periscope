# Periscope

Periscope is a Laravel Telescope-style runtime recorder and local dashboard for AdonisJS v7. It
correlates the work an application actually performs—HTTP requests, database queries, exceptions,
logs, events, commands, mail, cache operations, model changes, authorization checks, dumps, and
outbound HTTP calls—without sending telemetry to an external service.

Periscope is a development and staging diagnostic tool, not an APM or a production tracing backend.
Recorded values remain in the configured local store.

## Requirements

- Node.js 24 or newer
- AdonisJS 7
- npm 11 or newer when contributing to this repository

Optional integrations activate only when their host packages are installed: Lucid, Mail, Cache, and
Bouncer.

## Two-minute quickstart

Install and configure the package:

```sh
npm install adonisjs-periscope
node ace add adonisjs-periscope
```

The configure hook creates `config/periscope.ts`, registers the provider early in `adonisrc.ts`,
adds the request watcher as the first server middleware, and installs the exception reporter mixin.
If you select the shared database driver, also run:

```sh
node ace migration:run
```

Start the application and open `/periscope`:

```sh
node ace serve --hmr
```

Generate some application traffic. New entries appear live and related work shares one batch. With
the default `sqlite-local` driver, data is written to `tmp/periscope.sqlite`.

### Verify the generated wiring

The request middleware must remain first so it can establish the correlation scope around all
downstream work:

```ts
// start/kernel.ts
server.use([
  () => import('adonisjs-periscope/middleware/request_watcher'),
  // other server middleware
])
```

The exception reporter preserves the application's existing handler and records during `report()`:

```ts
// app/exceptions/handler.ts
import { ExceptionHandler } from '@adonisjs/core/http'
import { withPeriscope } from 'adonisjs-periscope/exception_reporter'

class HttpExceptionHandler extends ExceptionHandler {}

export default withPeriscope(HttpExceptionHandler)
```

Query recording requires Lucid query events. Enable `debug: true` on the Lucid connection you want
to observe.

## Configuration

`config/periscope.ts` exports `defineConfig(...)`. The generated stub documents every option and
starts with safe local defaults:

```ts
import { defineConfig } from 'adonisjs-periscope/periscope_config'

export default defineConfig({
  applicationName: 'billing-api',

  enabledIn: ['development', 'test'],

  storage: {
    driver: 'sqlite-local',
    maxEntries: 10_000,
  },

  recording: {
    caps: { default: 100, query: 200 },
    sampleRate: 1,
  },

  dashboard: {
    path: '/periscope',
  },
})
```

`PERISCOPE_ENABLED=true` explicitly enables recording outside `enabledIn`;
`PERISCOPE_ENABLED=false` disables it everywhere. When disabled, the provider installs no watcher,
logger, process, model, or dashboard hooks.

### Storage drivers

| Driver         | Use                             | Notes                                                                                         |
| -------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `sqlite-local` | Default local development       | Dedicated SQLite database, defaulting to `tmp/periscope.sqlite`; no Lucid dependency          |
| `database`     | Shared or remote inspection     | Uses a Lucid connection and the package migration; configure `storage.connection` when needed |
| `memory`       | Tests and short-lived processes | Bounded process-local ring buffer; all entries disappear at process exit                      |

All drivers enforce `storage.maxEntries`. `sqlite-local` uses WAL mode and indexed, chunked
operations; the database driver keeps the same storage contract across supported Lucid databases.

Every stored entry carries `applicationName`. A shared database can therefore serve several
applications without mixing counts, indexes, exception groups, or scoped clears. The dashboard
application selector persists its choice in the URL.

## Dashboard security

The dashboard and JSON/SSE API live below `dashboard.path`. Every dashboard request passes the
environment gate and then `dashboard.authorize`. The default authorizer denies requests in
production; override `dashboard.authorize` explicitly to enable access there.

Request details surface repeated query-family warnings at `dashboard.nPlusOneThreshold`, an active
OpenTelemetry trace ID when `@opentelemetry/api` is installed, and a JSON batch export suitable for
bug reports. Exports contain the application label and JSON-safe entries; they never initiate an
outbound request.

For a deliberately exposed non-development environment, require an application-specific identity:

```ts
export default defineConfig({
  enabledIn: ['development', 'staging'],

  dashboard: {
    path: '/internal/periscope',
    authorize: async ({ auth }) => {
      await auth.check()
      return auth.user?.email === 'operator@example.com'
    },
  },
})
```

Do not use a guessable URL as authorization. Terminate TLS at the application or a trusted proxy,
protect the route with the same identity controls as other operational tools, and keep the
production environment disabled unless an incident workflow requires it.

Mail HTML is sanitized before rendering, then placed in an iframe with an empty `sandbox` and a
`no-referrer` policy. Remote images, scripts, forms, embedded content, event handlers, refreshes,
and network-capable CSS are removed.

## Production sampling recipe

Periscope is off in production by default. If an incident requires temporary production recording,
combine explicit enablement, strict authorization, aggressive sampling, low caps, redaction, and
short retention:

```ts
import {
  DEFAULT_REDACT_HEADERS,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_VALUE_PATTERNS,
  REDACT_EMAIL_PATTERN,
  defineConfig,
} from 'adonisjs-periscope/periscope_config'

export default defineConfig({
  enabledIn: ['development', 'test', 'production'],

  storage: {
    driver: 'database',
    connection: 'periscope',
    maxEntries: 2_000,
  },

  recording: {
    sampleRate: 0.01,
    caps: { default: 20, query: 50 },
    keepAlways: (batch) =>
      batch.hasEntryOfType('exception') ||
      batch.hasEntryWhere(
        (entry) => entry.type === 'request' && Number(entry.content.status) >= 500
      ),
  },

  redact: {
    keys: [...DEFAULT_REDACT_KEYS, 'tenantSecret'],
    headers: [...DEFAULT_REDACT_HEADERS],
    valuePatterns: [...DEFAULT_REDACT_VALUE_PATTERNS, REDACT_EMAIL_PATTERN],
  },

  watchers: {
    request: { captureResponse: false, captureSession: false },
    query: { hideBindings: true },
    command: { enabled: false },
    mail: { enabled: false },
    cache: { captureValues: false },
    model: { captureDirty: false },
    gate: { enabled: false },
    dump: { enabled: false },
  },

  dashboard: {
    authorize: async ({ auth }) => {
      await auth.check()
      return auth.user?.isPeriscopeOperator === true
    },
  },
})
```

Set `PERISCOPE_ENABLED=true` only for the incident window, monitor storage growth, then disable and
clear retained data. Sampling is decided once per batch so correlated entries stay together.
Monitored tags and `recording.keepAlways` can retain a sampled-out batch.

Value-level redaction is on by default for bearer/JWT credentials, common `sk-`, `ghp_`, and
`AKIA` keys, password assignments and URL connection credentials, and Luhn-valid payment-card
numbers. These patterns scrub secrets even inside opaque strings such as query bindings, logs,
mail bodies, model/gate values, and response previews. Email redaction is intentionally opt-in via
`REDACT_EMAIL_PATTERN`; set `valuePatterns: false` only when value scanning must be disabled while
retaining key and header redaction.
To bound recorder CPU, individual strings over the serializer's 16 KiB default ceiling are not
pattern-scanned; deny-listed keys are still replaced wholesale.

## Watcher reference

Core watchers are enabled by default. The infrastructure integrations `job_schedule`, `redis`, and
`session` are off by default and subscribe to nothing until explicitly enabled.

| Watcher        | Source                                                       | Recorded content                                                                                                                                              |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`      | Request middleware and `http:request_completed`              | Method, URL, query, route, redacted headers and payload, status, duration, memory delta, client identity summary, optional response/session, disconnect state |
| `query`        | Lucid `db:query`                                             | SQL, serialized or hidden bindings, connection, model/method, duration, transaction/DDL flags, compact error                                                  |
| `exception`    | Exception handler mixin and process observers                | Name, message, code/status, stack, parsed frames, application code frame, request summary, serialized context                                                 |
| `log`          | AdonisJS/Pino destination                                    | Level, message, context, and source timestamp; self-generated Periscope logs are excluded                                                                     |
| `event`        | AdonisJS emitter                                             | Event name, serialized payload, class-event identity, and listener count                                                                                      |
| `command`      | Ace lifecycle                                                | Command, arguments, flags, main-command state, exit code, duration, optional output/error                                                                     |
| `mail`         | AdonisJS Mail lifecycle                                      | Lifecycle event, mailer, envelope, subject, optional rendered bodies/raw MIME, message ID, metadata, response/error                                           |
| `cache`        | Bentocache events                                            | Hit, miss, set, delete, or clear; store, key, cache layer/grace state, optional value                                                                         |
| `model`        | Lucid model lifecycle                                        | Create, update, or delete; model, primary key, optional attributes and dirty diff                                                                             |
| `gate`         | Bouncer authorization events                                 | Ability, decision, user ID, arguments, optional user/status/message                                                                                           |
| `dump`         | `dump()` helper                                              | Safely serialized values and the application call site                                                                                                        |
| `http_client`  | Node diagnostics channel for Undici                          | Method, URL, status, duration, redacted request/response headers, completion/error                                                                            |
| `job_schedule` | Pluggable queue adapters (BullMQ reference adapter included) | Scheduled job metadata plus completed/failed job status, attempts, duration, and opt-in payload/result                                                        |
| `redis`        | `@adonisjs/redis` diagnostics channel                        | Command, argument count, duration, error, and opt-in arguments; `AUTH` arguments are always replaced                                                          |
| `session`      | `@adonisjs/session` lifecycle events                         | Initiated, committed, or migrated state with hashed session IDs and opt-in redacted values                                                                    |

Watcher-specific options in the generated config control sensitive or expensive captures. All
application-owned values pass through bounded serialization and recursive redaction before storage.

Queue integrations use the exported `QueueWatcherAdapter` contract. The BullMQ reference adapter
observes queue events without replacing application workers:

```ts
import { defineConfig } from 'adonisjs-periscope/periscope_config'
import { BullQueueAdapter } from 'adonisjs-periscope/watchers/bull_queue'

export default defineConfig({
  watchers: {
    job_schedule: {
      enabled: true,
      adapters: [
        new BullQueueAdapter({
          queues: [{ name: 'mail', connection: { host: '127.0.0.1', port: 6379 } }],
        }),
      ],
    },
    redis: { enabled: true, captureArguments: false },
    session: { enabled: true, captureValues: false },
  },
})
```

## Hooks and extensibility

### Filter and tag hooks

Hooks run before an entry enters the recorder buffer:

```ts
export default defineConfig({
  hooks: {
    filter: [(entry) => entry.type !== 'request' || entry.content.routePattern !== '/health'],
    tag: [
      (entry) =>
        entry.type === 'request' && typeof entry.content.routePattern === 'string'
          ? [`route:${entry.content.routePattern}`]
          : [],
    ],
  },
})
```

A filter returning `false` drops the entry. A tag hook returns extra exact-match tags. Hooks are
safeguarded: an application hook failure is reported internally and cannot break the host request.

### Custom watcher

`Watcher` is the lifecycle contract: a stable `name`, idempotent `register()`, and optional
idempotent `cleanup()`. A custom application watcher can subscribe to a domain source and feed an
existing entry type to `Recorder.record()`:

```ts
import { EntryType, IncomingEntry, type Watcher } from 'adonisjs-periscope'
import type { Recorder } from 'adonisjs-periscope'

export class PaymentWatcher implements Watcher {
  readonly name = 'payment'
  #unsubscribe: (() => void) | null = null

  constructor(
    private recorder: Recorder,
    private subscribe: (listener: (paymentId: string) => void) => () => void
  ) {}

  register() {
    if (this.#unsubscribe !== null) return
    this.#unsubscribe = this.subscribe((paymentId) => {
      this.recorder.record(
        IncomingEntry.make(EntryType.EVENT, {
          name: 'payment:settled',
          payload: { paymentId },
          isClassEvent: false,
        }).withTags(['domain:payments'])
      )
    })
  }

  cleanup() {
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }
}
```

Create and register it from an application provider after resolving `Recorder` from the container;
clean it up during provider shutdown. Prefer the built-in event watcher when the source is already
an AdonisJS emitter event.

### Custom store

`PeriscopeStore` is the complete persistence boundary. A store implements entry save/find/list,
counts, exception grouping, clear/prune, monitored tags, flags, and `close()`. `MemoryStore`,
`SqliteLocalStore`, and `DatabaseStore` are reference implementations.

The built-in provider intentionally accepts only the three documented driver names. Advanced
applications that need a custom backend should implement `PeriscopeStore`, construct `Recorder`
with that store in an application provider, and wire custom watcher instances to that recorder.
This keeps custom persistence behavior explicit instead of overloading the package driver resolver.

## Commands

```sh
node ace periscope:clear
node ace periscope:prune --hours=24
node ace periscope:pause
node ace periscope:resume
```

The commands start the application, use the configured store, and keep their own work out of the
recorded timeline. Pause state is shared through the store and expires unless refreshed.

## FAQ

### Why is the dashboard empty?

Check `enabledIn` and `PERISCOPE_ENABLED`, confirm the request middleware is first, enable Lucid
`debug` for query events, confirm the selected storage path/connection is writable, and generate
fresh traffic after Periscope has booted.

### Why are database queries missing?

The query watcher consumes Lucid's `db:query` event, which is emitted only when the connection has
`debug: true`. Also confirm `watchers.query.enabled` is not `false`.

### Why are entries missing under sampling?

Sampling keeps or drops the whole batch. Raise `recording.sampleRate`, add a monitored tag, or use
`recording.keepAlways` for important exceptions, slow requests, or error responses.

### Why can asynchronously emitted work appear after the request entry?

AdonisJS emitters and diagnostics sources may complete listener work after the host callback
returns. Periscope assigns sequence numbers when signals are captured, tracks in-flight request
completion work, and accepts late fragments into the same batch. The timeline orders by sequence;
it does not block the host response to manufacture synchronous listener ordering.

### Why did an entry contain `[Truncated]`, `[Circular]`, or `[Unserializable]`?

Those are deliberate safety markers from bounded serialization. Periscope limits depth, entry
size, and hostile object traversal so diagnostics cannot hang or exhaust the application.

### Can Periscope call an external service?

The shipped package code has no outbound telemetry path and CI forbids network APIs in package
source. The HTTP client watcher observes diagnostics events; it does not issue requests.

### Is it safe to expose `/periscope` publicly?

No. Keep it disabled in production by default. If exposure is required, use a real authorization
policy, TLS, restrictive retention/capture settings, and a short explicit enablement window.

## Repository development

This repository is an npm workspace monorepo:

| Path                 | Package                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `packages/periscope` | Publishable AdonisJS provider, recorder, watchers, storage, HTTP API, commands |
| `packages/dashboard` | Private React dashboard built into the publishable package                     |
| `playground`         | AdonisJS integration fixture                                                   |

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the runtime pipeline and module layout, and
[CONTRIBUTING.md](CONTRIBUTING.md) for architecture invariants, focused test commands, security
review requirements, and benchmark gates.

## Release policy

Releases use Changesets and publish the `adonisjs-periscope` package from GitHub Actions with npm
provenance. CI builds a real tarball and rejects it unless the provider, package entry point,
dashboard HTML, and hashed dashboard assets are present. The compatibility matrix covers the
oldest supported and latest AdonisJS 7 and Lucid 22 releases.

Every user-facing change requires `npm run changeset`; the release PR owns versioning, and merging
it owns publication.

## License

MIT
