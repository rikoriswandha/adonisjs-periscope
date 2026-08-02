# Roadmap

Improvement and feature candidates identified after the 0.2.0 wave (search, retention,
overview page, theming, view/health_check/transmit watchers, queue adapters, extension
seams). Every item is grounded in current source with file references. Ratings are
value / effort (H/M/L).

## 1. Bugs and drift to fix first

**Status: shipped.** Route inventory is generated from `src/http/route_manifest.ts` (single
source for registration and doctor), retry-promising comments corrected, monitored-tag read
failures now reuse the last-known set, and the `EntryType` catalogue is documented as open.

| #   | Item                                                                                                                                                                                                                                                                                  | Evidence                                                                                                                                                          | Rating |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Doctor route inventory is stale and false-positives on valid routes. The expected list omits `/api/batches/:batchId/export`, `/api/csrf-token`, and `/api/stats`, so the collision counter flags Periscope's own routes. Generate the inventory from the route registration contract. | `src/hooks/doctor.ts:595-615` vs `src/http/routes.ts:49-58`                                                                                                       | H / L  |
| 2   | Store-failure comments promise a retry that does not exist. Comments describe the recorder retrying a failed flush; in reality `flush()` swallows the rejection and a request performs its final flush exactly once. Correct the comments now (real retry is item 12).                | `src/storage/sqlite_local_store.ts:89-94`, `src/storage/database_store.ts:338-342`, `src/recorder/recorder.ts:478-498`, `src/watchers/request/watcher.ts:642-657` | M / L  |
| 3   | Monitored-tag read failure fails open to 100% capture. A store error returns `null`, which the flush decision treats as "keep every sampled-out batch" — a slow store incident amplifies its own write load. Keep the last-known tag set instead.                                     | `src/recorder/recorder.ts:340-370`, `:557-588`                                                                                                                    | H / L  |
| 4   | Stale `EntryType` "catalogue is fixed" comment contradicts reality (plain `varchar(32)` column; types have been added twice already).                                                                                                                                                 | `src/types.ts:31-35`, `src/storage/database_schema.ts:79-101`                                                                                                     | L / L  |

## 2. Analytics API — the biggest single gap

**Status: shipped.** `GET /api/stats?from=&to=&bucket=&group_by=route` is backed by
`PeriscopeStore.requestStats` (store-side windowing, bounded sampling, exact nearest-rank
percentiles) in all three drivers, and the entries list accepts `level`, `sort` (allowlisted),
and `direction` end to end.

The legacy no-parameter mode still serves the newest-500 overview unchanged; the dashboard
features unlocked below (error-rate chart, real throughput axis, per-route table, exception
sparklines) can now be built on the bucketed API.

| #   | Item                                                                                                                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                          | Rating |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 5   | Bucketed stats endpoint: `stats?from=&to=&bucket=&group_by=` with store-side counts, error rates, and duration percentiles.                                             | Unlocks: error-rate-over-time chart, a real throughput chart (the current chart plots latency against synthetic `new Date(index)` timestamps — `packages/dashboard/src/components/request-activity-chart.tsx:16-37`), a per-route latency table (route/status/duration are already recorded per entry, `packages/dashboard/src/types.ts:108-119`, but never grouped), and exception occurrence sparklines. Highest-leverage item on this list. | H / M  |
| 6   | Log-level filter and allowlisted sorting. Level is recorded and rendered but unfilterable (the list parser has no `level` parameter); no sort contract exists anywhere. | `src/http/controllers/entries_controller.ts:114-151`, `packages/dashboard/src/components/entry-index-table.tsx:19-25`                                                                                                                                                                                                                                                                                                                          | H / M  |

## 3. Recorder and storage robustness

**Status: shipped.** The live stream runs on a `FlushFanout` seam (`dashboard.fanout` factory;
in-process default) with a best-effort store-lease deduplicating retention across workers;
failed database saves retry with bounded backoff and both SQL drivers expose
pending/dropped/failed/retried counters on `/api/status`; late fragments flush into a
grace-period continuation batch sharing the original batch id (`recording.lateEntryGraceMs`);
queue adapters plant a correlation id at dispatch and wrap execution so cross-process job
lifecycles share one batch; retention accepts `perType` hour overrides; monitored tags are
keyed `(application, tag)`; and the database driver uses `ILIKE` with best-effort pg_trgm
artifacts on Postgres (see `docs/UPGRADING.md`).

| #   | Item                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                     | Rating  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------- |
| 7   | Multi-process correctness. SSE fanout is a per-worker in-memory listener list — a dashboard client on worker A never sees worker B's flushes. Retention timers run in every process; `sseMaxClients` is enforced per worker. Add a store/pub-sub fanout seam plus a maintenance lease, or document single-process-only loudly. | `src/http/controllers/stream_controller.ts:32-43`, `providers/periscope_provider.ts:248-282`                                 | H / H   |
| 8   | Bounded retry / dead-letter for failed saves plus an explicit overload policy. The database driver silently drops the oldest pending batch at 64 in flight; the SQLite pending queue is unbounded and drains synchronously on the event loop. Expose drop counters in `/api/status`.                                           | `src/storage/database_store.ts:282-307`, `src/storage/sqlite_local_store.ts:466-467,659-673`                                 | H / M-H |
| 9   | Late-fragment loss after final flush. Fire-and-forget work that inherits a closed request context appends to a buffer nothing will ever flush; only the http_client watcher handles this case. Needs a closed-context state routing late entries to a continuation batch or a bounded grace-period finalizer.                  | `src/recorder/context.ts:81-100` vs `src/watchers/request/watcher.ts:642-657`, `src/watchers/http_client/watcher.ts:404-409` | H / H   |
| 10  | Queue batch correlation does not span processes. Job start/finish in different workers produce uncorrelated batches; job execution work (queries, logs) is never scoped — the queue context is installed only around the final entry write. Propagate a batch ID through job metadata; wrap execution.                         | `src/watchers/job_schedule/watcher.ts:140-180`, `:143-147`                                                                   | H / H   |
| 11  | Per-type retention. One global `hours` + `keepExceptions`; cannot keep exceptions or mail for a week while pruning queries after a day. Telescope-parity gap.                                                                                                                                                                  | `src/types.ts:1005-1017`, `:322-340`                                                                                         | H / M   |
| 12  | Application-scoped monitored tags. The schema keys tags globally, so in a shared store one application's monitored tag inflates every application's capture volume.                                                                                                                                                            | `src/storage/database_schema.ts:151-153`, `src/http/routes.ts:64-66`                                                         | H / M   |
| 13  | Postgres text search. The database driver runs `lower(content) LIKE` full scans — the slowest search implementation exactly where stores are largest. Add pg_trgm / tsvector per dialect with a documented fallback.                                                                                                           | `src/storage/database_store.ts:210-212`                                                                                      | H / H   |

## 4. Dashboard workflows

**Status: shipped.** The batch page renders a real lane-packed waterfall with a time axis and
proportional duration bars; exception families carry resolve/ignore state (flag-backed,
reopen-on-new-occurrence at read time) with a triage filter and lazy 24h occurrence sparklines;
tables offer a two-entry compare diff, an opt-in live-tail mode with scroll-away pause, and
pin/note metadata (`PUT /api/entries/:uuid/metadata`, `GET /api/entry-metadata`); SSE frames
carry `id:` with `Last-Event-ID` replay and an `application` filter, one BroadcastChannel
leader shares the tab pool's EventSource, and refetches are debounced; the shortcut panel is a
real coss Dialog and table skeletons/error banners carry `status`/`alert` roles.

| #   | Item                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                            | Rating |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 14  | Real batch waterfall. The current "timeline" is an ordered list whose offset column is the array index — no time axis, proportional bars, or concurrency. The flagship diagnostic view.                                                                                                                         | `packages/dashboard/src/pages/request-batch-page.tsx:144-190`                                                                       | H / H  |
| 15  | Exception triage: resolve/ignore state plus occurrence trend. Groups expose only count and last-seen; no mutation routes exist. Define reopen-on-new-occurrence semantics.                                                                                                                                      | `src/http/serialize.ts:15-20`, `src/http/routes.ts:49-69`                                                                           | H / H  |
| 16  | Compare two requests/entries. The APIs already return everything needed; tables just lack a multi-select model. Client-side diff first — no server work.                                                                                                                                                        | `packages/dashboard/src/lib/api.ts:130-143`, `packages/dashboard/src/components/entry-index-table.tsx:107-129`                      | H / M  |
| 17  | Live-tail mode. Current model is a manual "N new entries" button; add auto-prepend with scroll-away pause, keeping the current behavior as the safe default.                                                                                                                                                    | `packages/dashboard/src/components/entry-index-table.tsx:64-75`                                                                     | M / M  |
| 18  | SSE efficiency: every flush triggers an abort-and-rescan cursor walk (debounce/coalesce); one `EventSource` per tab drains the 5-client pool (share via a BroadcastChannel leader); the stream has no application filter (server broadcasts everything, client discards) and no `id:` / `Last-Event-ID` replay. | `packages/dashboard/src/hooks/use-polling.ts:89-148`, `src/http/controllers/stream_controller.ts:134-143`                           | H / M  |
| 19  | Pins and notes on entries. Needs a small user-metadata record keyed by entry UUID (never mutate recorded payloads) plus two routes, with retention/orphan semantics.                                                                                                                                            | `packages/dashboard/src/types.ts:27-38`, `src/http/routes.ts:59-66`                                                                 | H / H  |
| 20  | Accessibility polish batch: the shortcut panel is a hand-rolled `role="dialog"` without focus trap or `aria-modal` (swap to the existing coss Dialog/Popover); add `role="status"` / `aria-busy` to table skeletons and `role="alert"` to the partial-error banner.                                             | `packages/dashboard/src/components/app-shell.tsx:801-826`, `packages/dashboard/src/components/entry-index-table.tsx:78-105,178-184` | M / L  |

## 5. New watchers and integrations

**Status: shipped.** Eight watchers/seams landed. VineJS validation failures are recorded by
wrapping the default error-reporter factory (`validation` entries; one reporter boundary covers
throwing `validate` and non-throwing `tryValidate`). `SchedulerWatcherAdapter` — parallel to
`QueueWatcherAdapter`, registered via `watchers.job_schedule.schedulers` — gives real cron/task
executions their own `schedule`-kind batches with `wrapTask` execution scoping. `@adonisjs/limiter`
rejections and `@adonisjs/lock` contention/timeouts are recorded through container-binding patches
(`rate_limit` / `lock` entries, `watchers.lock.contentionMs` threshold). `@adonisjs/drive` file
operations, `ally` OAuth steps (token-free identity summaries) and `i18n` missing translations get
semantic entries. Notification and WebSocket lifecycles ship as adapter seams
(`NotificationWatcherAdapter`, `SocketWatcherAdapter`) rather than couplings. Requests terminated
before routing (for example by `@adonisjs/static`) are summarized behind
`watchers.request.captureStatic`, default off. All eight entry types render in the dashboard; the
config stub and README document every new block.

| Target                                                          | Signal                                                                                                                                                                              | Rating  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Vine validation failures                                        | Error-reporter wrapper; structured fields/rules/messages, including non-throwing `tryValidate`. The most common request-debugging signal not captured today.                        | H / M   |
| Scheduled tasks (real cron)                                     | Scheduler-adapter contract parallel to `QueueWatcherAdapter`. Today `SCHEDULE` means "delayed queue dispatch", not task execution (`src/watchers/job_schedule/watcher.ts:106-137`). | H / M   |
| `@adonisjs/limiter` rejections, `@adonisjs/lock` contention     | Semantic entries for otherwise-anonymous Redis/SQL operations.                                                                                                                      | M / M   |
| `@adonisjs/drive` file ops, `ally`, `i18n` missing translations | Lower volume semantic integrations.                                                                                                                                                 | M / M-L |
| Notification adapter contract                                   | No official AdonisJS notification package — ship a seam, not a coupling.                                                                                                            | M / M   |
| Static-request classification                                   | Requests terminated early by `@adonisjs/static` are currently invisible (`src/watchers/request/watcher.ts:480-489`). Default off or summarized.                                     | M / M   |
| WebSocket lifecycle                                             | Transmit watcher covers server-to-client broadcasts only; no connect/disconnect/inbound-message coverage. Pluggable socket adapter.                                                 | M / H   |

## 6. DX and ecosystem

**Status: shipped.** `@rikology/adonisjs-periscope/testing` ships `flushAndWait`, `findEntries`,
`assertRecorded` / `assertNotRecorded`, application-scoped `clearRecorded`, and a Japa
`periscopePlugin` over the same primitives (docs/TESTING.md; the playground suite consumes it).
The doctor is a first-class `node ace periscope:doctor` command sharing one check engine with the
Assembler hook, extended with provider-order, exception-wrapper, and Shield/CSRF checks plus a
conservative `--fix` for Lucid `debug: true`. The batch-export v1 envelope is published
(`parseBatchExport`, `BATCH_EXPORT_FORMAT`/`BATCH_EXPORT_VERSION`, docs/BATCH_EXPORT.md) with a
`node ace periscope:import` counterpart that keeps uuids/batch ids, assigns fresh sequences, and
skips or rejects already-imported entries. `/api/*` is declared experimental with a full
hand-verified reference in docs/API.md and a stated graduation gate for Tuyau/MCP clients. The
release workflow requires a green CI run for the exact SHA, CI enforces dashboard gzip bundle
budgets (scripts/check-bundle-size.mjs) and runs a Windows/macOS smoke job. New docs:
docs/OPERATIONS.md runbook, docs/ADAPTERS.md authoring guide, docs/TESTING.md, expanded
docs/UPGRADING.md, and a slimmer README linking the docs index.

| #   | Item                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                 | Rating  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| 21  | `@rikology/adonisjs-periscope/testing` export. Consumers can only assert via raw recorder/store internals — the playground hand-rolls polling and settling windows. Ship `flushAndWait`, `findEntries`, `assertRecorded` / `assertNotRecorded`, application-scoped cleanup; optional Japa plugin over the same primitives. Biggest adopter-retention feature. | `playground/tests/functional/periscope_watchers.spec.ts:35-123`, `packages/periscope/package.json:49-53` | H / M   |
| 22  | `node ace periscope:doctor` command. The doctor exists only as an opt-in Assembler init hook nobody registers (the configure checklist tells users to wire it manually). Make it a command, extend checks (provider order, exception wrapper, Shield), add `--fix` for the Lucid `debug: true` step — the top "why are queries missing" cause.                | `configure.ts:767-769`, `src/hooks/doctor.ts:762-836`                                                    | H / M   |
| 23  | Publish the batch-export v1 schema and add an import path. The export envelope is versioned but the schema is private and there is no import — a bug-report batch cannot be loaded into a local dashboard. Import plus offline viewing makes the format actually useful.                                                                                      | `src/batch_export.ts:11-34`, `src/types.ts:361-460`                                                      | H / M   |
| 24  | API stability contract. Declare `/api/*` internal, experimental, or public; if public, publish response/query schemas (enables a Tuyau client, and later a read-only localhost MCP server for AI-agent debugging — gate that behind schema stability, separate package, redaction preserved).                                                                 | `docs/ARCHITECTURE.md:131-149`, `packages/periscope/package.json:32-47`                                  | H→M / M |
| 25  | CI/release hardening. The release workflow packs and publishes without running lint/typecheck/tests — make it depend on a green CI SHA. Add dashboard bundle-size budgets (chart/font/motion/SQL-formatter dependencies are untracked). Add a small Windows/macOS smoke job for better-sqlite3, paths, and configure codemods.                                | `.github/workflows/release.yml:30-65`, `.github/workflows/ci.yml:66-75,185-189`                          | M-H / M |
| 26  | Docs: `docs/UPGRADING.md`, a shared-store multi-app operations runbook, adapter-authoring guides (the README shows adapter consumption only). Split the 517-line README once those exist.                                                                                                                                                                     | `README.md:302-326,470-512`                                                                              | M / M   |

## Suggested sequencing

1. ~~Quick fixes (items 1-4, 20)~~ — shipped.
2. ~~Bucketed stats API (5) + per-route table + level filter (6)~~ — shipped.
3. ~~Testing export (21) + doctor command (22)~~ — shipped, alongside the rest of §6 (batch
   export schema + import, API stability contract, CI/release hardening, docs split).
4. ~~SSE efficiency (18) + per-type retention (11) + tag scoping (12)~~ — shipped.
5. ~~Vine + scheduler watchers~~ — shipped, alongside the rest of §5 (limiter/lock, drive/ally/i18n, notification/socket seams, static-request capture).
6. ~~Waterfall (14) + exception triage (15)~~ — shipped, alongside compare (16), live tail (17) and pins/notes (19).
7. ~~Multi-process story (7-10)~~ — shipped as one wave: fanout seam, lease, continuation batches, queue correlation.
