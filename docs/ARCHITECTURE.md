# Periscope architecture

This document describes how the published `@rikology/adonisjs-periscope` package is put together. For
usage and configuration, see the [README](../README.md); for contribution workflow, invariants,
and verification commands, see [CONTRIBUTING](../CONTRIBUTING.md).

## Overview

Periscope records the work an AdonisJS application performs and serves a local dashboard over
that data. Everything runs inside the host process; nothing leaves it.

```text
host signal -> watcher -> IncomingEntry -> Recorder -> PeriscopeStore -> JSON/SSE API -> dashboard
```

- **Watchers** subscribe to host signals (middleware, emitter events, diagnostics channels,
  lifecycle hooks) and translate them into typed entries.
- The **Recorder** correlates entries into batches, applies sampling, caps, hooks, redaction,
  and bounded serialization, then flushes to storage.
- A **store** persists entries behind a single portable contract.
- The **HTTP layer** exposes JSON and SSE endpoints below the configured dashboard path, including
  mutations for flags, stored-data clearing, and monitored tags, and serves the single-page dashboard.

## Workspace layout

| Path                 | Contents                                                                  |
| -------------------- | ------------------------------------------------------------------------- |
| `packages/periscope` | Publishable package: provider, recorder, watchers, storage, HTTP API, ace commands, stubs, tests |
| `packages/dashboard` | Private Vite/React SPA; its build output is copied into `packages/periscope/build/dashboard` |
| `playground`         | Booted AdonisJS v7 fixture application used by integration, security, and benchmark suites |

## Boot and lifecycle

`providers/periscope_provider.ts` owns the runtime lifecycle:

1. Evaluate the environment gate (`enabledIn` plus the `PERISCOPE_ENABLED` override) before
   constructing anything. Disabled means inert: no store, no watcher, logger, process, model,
   or dashboard hooks are installed.
2. Construct the configured store and bind the `Recorder` class as a container singleton. The
   `@rikology/adonisjs-periscope/services/recorder` subpath resolves that same class binding.
3. Register the enabled watchers from `src/watchers/registry.ts`, followed by any
   `watchers.custom` factories. Optional integrations (Lucid, Mail, Cache, Bouncer, Edge,
   health checks, Transmit, Redis, Session, BullMQ, `@adonisjs/queue`) register only when the
   host package is installed and the watcher is enabled.
4. Mount the dashboard routes and authorization middleware below `dashboard.path`.
5. When `storage.retention` is configured, start an unref'd prune interval after ready.
6. On shutdown, stop the retention timer, clean up watchers, flush pending work, and close the
   store.

The `configure.ts` hook (run by `node ace add @rikology/adonisjs-periscope`) publishes the config stub,
registers the provider, inserts the request middleware first in the server middleware stack,
and installs the exception reporter mixin.

## Watchers

Each watcher lives in `src/watchers/<name>/` and implements the `Watcher` contract: a stable
`name`, an idempotent `register()`, and an optional idempotent `cleanup()`. Watchers never
throw into host code paths — every entry point is wrapped by `src/safeguard.ts`, which reports
failures through the guarded internal logger and drops the signal.

Signal sources by watcher:

| Watcher        | Source                                                       |
| -------------- | ------------------------------------------------------------ |
| `request`      | Server middleware (`src/watchers/request/middleware.ts`) plus `http:request_completed` |
| `query`        | Lucid `db:query` emitter event (requires `debug: true` on the connection) |
| `exception`    | Exception handler mixin (`src/watchers/exception/mixin.ts`) and process-level observers |
| `log`          | A Pino destination stream (`src/watchers/log/stream.ts`)      |
| `event`        | The AdonisJS emitter                                          |
| `command`      | Ace command lifecycle hooks                                   |
| `mail`         | AdonisJS Mail lifecycle events                                |
| `cache`        | Bentocache events                                             |
| `model`        | Lucid model lifecycle hooks                                   |
| `gate`         | Bouncer authorization events                                  |
| `dump`         | The exported `dump()` helper                                  |
| `http_client`  | Node diagnostics channel for Undici                           |
| `view`         | Edge `onRender` renderer hook                                 |
| `health_check` | Patched `HealthChecks.prototype.run` from `@adonisjs/core`    |
| `job_schedule` | Pluggable `QueueWatcherAdapter` instances; `bull_queue_adapter.ts` observes BullMQ via `QueueEvents`, `adonis_queue_adapter.ts` observes `@adonisjs/queue` tracing channels |
| `redis`        | `@adonisjs/redis` diagnostics channel                         |
| `session`      | `@adonisjs/session` lifecycle events                          |
| `transmit`     | `@adonisjs/transmit` `on('broadcast')` hook plus a patched `broadcastExcept` |

The HTTP client watcher only *observes* diagnostics events; the package itself has no outbound
network capability, and CI lints package source against network APIs.

## Recorder

`src/recorder/` is the correlation and safety core:

- `context.ts` maintains the `BatchScope` (AsyncLocalStorage) so all work triggered by one
  request, command, or job shares a batch ID. The request middleware must stay first in the
  middleware stack to establish this scope around downstream work.
- `sequence.ts` assigns monotonic sequence numbers at capture time; the dashboard timeline
  orders by sequence, so late asynchronous fragments still land in the right batch without
  blocking the host response.
- `serializer.ts` performs bounded serialization: depth, size, and traversal limits produce
  `[Truncated]`, `[Circular]`, and `[Unserializable]` markers instead of hanging on hostile
  values.
- `redactor.ts` recursively redacts configured keys and headers **before** entries enter the
  recorder buffer. Nothing relies on display-time masking.
- `recorder.ts` applies filter/tag hooks, per-batch caps, and batch-level sampling
  (`sampleRate`, monitored tags, `keepAlways`), then flushes to the store in chunks.
- `ambient.ts` handles entries recorded outside any batch scope (process-level exceptions,
  background work).
- `trace_context.ts` captures the active OpenTelemetry trace ID when `@opentelemetry/api` is
  present.

The recorder mutes itself: storage queries, internal logs, dashboard traffic, and Periscope
commands run in a muted scope so Periscope never records its own work.

## Storage

`src/storage/` provides three implementations of the single `PeriscopeStore` contract
(save/find/list, counts, exception grouping, clear/prune, monitored tags, flags, `close()`),
plus a `custom` driver that delegates construction to `storage.factory`:

| Store              | File                    | Notes                                                    |
| ------------------ | ----------------------- | -------------------------------------------------------- |
| `MemoryStore`      | `memory_store.ts`       | Bounded process-local ring buffer                        |
| `SqliteLocalStore` | `sqlite_local_store.ts` | Dedicated `better-sqlite3` database, WAL mode, chunked and indexed operations; no Lucid dependency |
| `DatabaseStore`    | `database_store.ts`     | Any supported Lucid connection using the package migration (`database_schema.ts`) |

All stores enforce `storage.maxEntries` and share ordering, pagination, tag, text-search,
time-range, flag, clear, and prune semantics — the storage test suite runs the same contract
against each driver. `SqliteLocalStore` accelerates text search with a trigger-maintained
trigram FTS5 index and falls back to escaped `LIKE`; the other drivers scan or `LIKE` portably.
Every row carries `applicationName`, which lets one shared database serve several applications
with scoped counts, exception groups, clears, and prunes.

## HTTP layer and dashboard

`src/http/routes.ts` mounts everything below `dashboard.path`:

- `controllers/entries_controller.ts`, `exception_groups_controller.ts`, and
  `monitored_tags_controller.ts` serve the JSON API, including text/time-range/multi-tag/log-level
  entry filters with allowlisted `sort`/`direction` ordering, single-entry lookup, and batch
  export; `dashboard_controller.ts` serves status, counts, flags, clear, and `GET /api/stats` —
  the bounded legacy overview by default, or store-side time-bucketed counts, error rates, and
  duration percentiles (optionally grouped by route) when `bucket`/`group_by` are present.
- `stream_controller.ts` serves the SSE live feed with a configurable connection cap
  (`dashboard.sseMaxClients`).
- `static_controller.ts` serves the built dashboard assets with path-traversal protection.
- `middleware/authorize.ts` re-runs the environment gate and `dashboard.authorize` on every
  JSON request and each SSE connection. A denied or disabled request reveals no asset or API
  content.

The dashboard (`packages/dashboard`) is a client-only HashRouter React SPA built with Vite. It
talks exclusively to the JSON/SSE API, uses COSS primitives in `src/components/ui` as the
component source of truth, and renders recorded mail HTML only after sanitization inside an
iframe with an empty `sandbox` and a `no-referrer` policy.

## Commands

`commands/` provides `periscope:clear`, `periscope:prune`, `periscope:export`,
`periscope:pause`, and `periscope:resume`. They boot the application, operate on the configured
store, and keep their own work out of the recorded timeline. Clear and prune accept
`--application` scoping; export writes versioned `periscope.batch` JSON. Pause state is
persisted through the store until resumed; `_ensure_durable_storage.ts` guards commands that
require a durable driver.

## Design invariants

The load-bearing rules, enforced by tests and CI (see CONTRIBUTING for the full list):

1. Recording is best effort — no Periscope failure may escape into host code paths.
2. Disabled means inert — the gate is evaluated before any construction or hook installation.
3. Correlation is batch-wide, and sampling is decided once per batch.
4. Values are redacted and bounded before they enter recorder memory.
5. Retention is bounded by per-batch caps, `storage.maxEntries`, and optional age-based
   `storage.retention` pruning.
6. Periscope never records itself.
7. All stores obey one portable contract.
8. Every dashboard request is authorized individually.
9. Package source has no outbound network capability.
10. Optional peer integrations load safely when absent.
