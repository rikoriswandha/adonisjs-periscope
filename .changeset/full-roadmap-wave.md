---
'@rikology/adonisjs-periscope': minor
---

Major feature wave: search, retention, new watchers, and a full dashboard upgrade.

**Search and filtering**

- `GET <dashboard>/api/entries` now accepts `text` (case-insensitive content search), inclusive
  ISO `from`/`to` time bounds, and repeated `tag` parameters with exact-match AND semantics.
  All three stores implement identical predicate behavior; `sqlite-local` accelerates text
  search with a trigger-maintained trigram FTS5 index (legacy databases are backfilled
  automatically) and falls back to escaped `LIKE` when FTS5 is unavailable.
- The dashboard search page supports free text, exact tags, entry type, and time ranges with
  15m/1h/24h presets; every index page gains tag and time-range filters. All filters persist in
  the URL. Query "Slow only" and request status-class filters are now server-side predicates.
- Requests are additionally tagged `status:2xx` through `status:5xx`; query families meeting
  `dashboard.nPlusOneThreshold` are persisted with the exact `n+1` tag; HTTP client entries gain
  `slow` (configurable `watchers.http_client.slowMs`, default 1000) and `failed` tags.

**Retention and commands**

- `storage.retention: { hours, keepExceptions? }` prunes old entries automatically on an unref'd
  15-minute interval.
- `periscope:clear` and `periscope:prune` accept `--application`; new `periscope:export
  --batch=<id> [--out=<file>]` writes the versioned `periscope.batch` JSON export.

**New watchers and integrations**

- `view`: Edge renders via the official `onRender` hook (template, duration, top-level data key
  names only). Enabled by default; silent no-op without Edge.
- `health_check`: records `HealthChecks.run()` reports with per-check status. Enabled by
  default; silent no-op without the health module.
- `transmit`: opt-in broadcast recording for `@adonisjs/transmit` (channel, event metadata,
  opt-in payload summary).
- `AdonisQueueAdapter` for the experimental `@adonisjs/queue` via its tracing channels; the
  BullMQ adapter now enriches entries with job name, attempts, and opt-in payload via bounded
  best-effort job lookups.
- Request entries record Inertia component and prop-key names when responses carry `X-Inertia`
  (`watchers.request.captureInertia`, default true; requires response capture).
- Ace command entries capture bounded, redacted terminal output
  (`watchers.command.captureOutput`, default true).

**Extensibility**

- `watchers.custom` registers application watcher factories with built-in lifecycle safeguards.
- `storage.driver: 'custom'` with `storage.factory` plugs in a custom `PeriscopeStore` without
  replacing provider wiring.
- **Breaking:** the orphan `EntryType.NOTIFICATION` (which no watcher ever produced) was removed.

**Dashboard**

- New Overview landing page (request p50/p95/error rate, activity chart, per-type counts, recent
  exception families, slow-query leaderboard) backed by the bounded `GET /api/stats` endpoint.
- New Logs, Events, Views, Health checks, Broadcasts, and Monitored tags pages.
- Entries are deep-linkable at `#/entries/<uuid>` with copy-link actions; typed detail renderers
  are reused across index pages, global search, batch timelines, and direct links; ambient
  batches gain JSON export.
- Light/dark/system theme with persistence and no load flash; the application selector survives
  navigation; keyboard shortcuts (`/`, `j`/`k`, `Esc`, `⌘/Ctrl+B`, `?`).
- SQL syntax highlighting in query details; `dashboard.sseMaxClients` bounds SSE clients.
