# Periscope — Implementation Plan

**Companion to:** `periscope-architecture.md` (v1.0 draft)
**Target:** AdonisJS v7, Node.js ≥ 24, ESM-only, TypeScript
**Plan style:** 9 phases → milestones → tasks with file paths, code skeletons, acceptance criteria, and test gates. Each phase ends in a shippable, demoable state.

---

## 0. Reading Guide & Ground Rules

- Task IDs are `P{phase}.{n}` and referenced in the dependency graph (§12).
- Every task lists **Deliverables** (files), **Done when** (acceptance criteria), and **Tests** where applicable.
- "Fixture app" = a minimal AdonisJS v7 web app living in `playground/` inside the monorepo, used for integration tests and manual QA.
- Estimates assume one experienced full-stack TypeScript developer familiar with AdonisJS. Sum ≈ **11–14 weeks** to a 1.0. A two-person split (core/watchers vs dashboard) compresses to ≈ 7–8 weeks because Phases 4–5 parallelize cleanly with 3 and 6.
- Non-negotiable invariants enforced from day one (CI-gated):
  1. Periscope never throws into host-app code paths — every watcher/recorder entry point is wrapped in a `safeguard()` try/catch that logs and drops.
  2. Periscope never records itself (recursion tests run in every phase after P2).
  3. No outbound network calls anywhere in the package (lint rule banning `fetch`/`http.request` outside the HttpClientWatcher's *subscription* code).

---

## Phase 0 — Repository, Tooling, CI (est. 2–3 days)

### P0.1 Monorepo scaffold

**Deliverables**

```
periscope/
├── package.json                  # workspace root
├── packages/
│   ├── periscope/                # the publishable package
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── configure.ts
│   │   ├── providers/
│   │   ├── src/
│   │   ├── stubs/
│   │   ├── commands/
│   │   └── tests/
│   └── dashboard/                # SPA source (built into packages/periscope/build/dashboard)
│       ├── package.json
│       ├── vite.config.ts
│       └── src/
├── playground/                   # fixture AdonisJS v7 app
└── .github/workflows/ci.yml
```

**Key `packages/periscope/package.json` decisions (write these now, they're load-bearing):**

```json
{
  "name": "periscope",
  "type": "module",
  "engines": { "node": ">=24" },
  "exports": {
    "./provider": "./build/providers/periscope_provider.js",
    "./services/recorder": "./build/src/recorder/service.js",
    "./middleware/request_watcher": "./build/src/watchers/request/middleware.js",
    "./exception_reporter": "./build/src/watchers/exception/mixin.js",
    "./dump": "./build/src/dump.js",
    "./hooks": "./build/src/hooks/doctor.js",
    "./commands": "./build/commands/main.js",
    "./types": "./build/src/types.js",
    "./periscope_config": "./build/src/define_config.js"
  },
  "files": ["build"],
  "peerDependencies": {
    "@adonisjs/core": "^7.0.0",
    "@adonisjs/lucid": ">=22.0.0"
  },
  "peerDependenciesMeta": { "@adonisjs/lucid": { "optional": true } }
}
```

Lucid is an *optional* peer: the sqlite-local driver bundles its own better-sqlite3 usage so API-only apps without Lucid still get storage (decided here to avoid rework in P2).

**Done when:** `npm run build` compiles the package; `npm -w playground run dev` boots the fixture app; CI runs typecheck + lint + unit tests on Node 24.

### P0.2 Test harness

- Japa for the package (`@japa/runner`, `@japa/assert`, `@japa/expect-type`); `@japa/plugin-adonisjs` in the playground for booted-app integration tests.
- Add `tests/helpers/app_factory.ts` that boots a throwaway Adonis application with an in-memory emitter/config for unit-level watcher tests (mirrors how official @adonisjs packages test themselves).

**Done when:** one placeholder unit test and one booted-app integration test pass in CI.

### P0.3 Fixture app (`playground/`)

A v7 app with: Lucid (sqlite, `debug: true`), session, one auth-less login stub, routes that exercise everything later phases need:

```
GET  /ok                  → 200 with query (User.all)
GET  /slow                → sleeps 300ms, runs a 150ms query
GET  /boom                → throws
POST /echo                → validated payload (includes "password" field for redaction tests)
GET  /fanout              → emits custom event, logs warn, sends fake mail
```

**Done when:** all routes respond; this app is the substrate for every "Done when" below.

---

## Phase 1 — Core: Entry, Context, Recorder (est. 1 week)

> Goal: `recorder.record(entry)` works end-to-end into an in-memory store with correct batch correlation, caps, muting, and hooks. No watchers yet except a throwaway test emitter.

### P1.1 `IncomingEntry` + types

**Deliverables:** `src/entry.ts`, `src/types.ts` (EntryType const, `StoredEntry`, `EntryQuery`, `Paginated`, watcher/config interfaces from the architecture §3.1, §7.1).

**Done when:** type tests (`expect-type`) lock the public shapes; `withTags/withFamilyHash/hiddenFromIndex` covered by unit tests.

### P1.2 Batch context (ALS)

**Deliverables:** `src/recorder/context.ts`

```ts
export class BatchScope {
  static storage = new AsyncLocalStorage<BatchContext>()

  static run<T>(kind: BatchKind, fn: () => T): T {
    const ctx: BatchContext = {
      batchId: randomUUID(), kind,
      startedAt: process.hrtime.bigint(),
      buffer: [], counters: {}, muted: false, truncated: {},
    }
    return this.storage.run(ctx, fn)
  }
  static current() { return this.storage.getStore() }
  static async mute<T>(fn: () => Promise<T>) { /* set muted in a child scope */ }
}
```

Plus the **ambient batch**: `src/recorder/ambient.ts` — a module-level context used when `current()` is undefined, rotated on a timer (default 10 s) and flushed by the provider's shutdown.

**Done when:** unit tests prove (a) entries recorded inside `BatchScope.run` share a batchId, (b) nested async callbacks (setTimeout, promise chains, emitter-style microtasks) inherit it, (c) no scope → ambient batch, (d) `mute` drops records only within its scope.

### P1.3 Recorder pipeline

**Deliverables:** `src/recorder/recorder.ts`, `src/recorder/redactor.ts`, `src/recorder/serializer.ts`

Pipeline order exactly as architecture §6.1: muted → enabled/paused → filter hooks → redaction → tag hooks → caps → buffer push. Also:

- `serializer.ts`: `safeSerialize(value, { maxDepth: 4, maxBytes })` using `util.inspect`-style traversal with circular handling, `toJSON` preference, Buffer/stream elision. This is shared by Event/Dump/Job watchers later — build it well now.
- `redactor.ts`: deep key-deny-list scrubbing (`[REDACTED]`), header scrub, configurable via config object injected at construction.
- Monotonic `sequence` stamped at record time (`hrtime.bigint()`).
- `flush(target: BatchContext)`: maps buffer → `StoredEntry[]`, appends a synthetic `truncation` note into the primary entry when caps fired, calls `store.save()` inside `BatchScope.mute()`, swallows+logs failures via a raw pino child (`periscope.internal`).

**Tests (the important ones):**

- Caps: 201st query entry in a batch is dropped, `truncated.query === 1`.
- Redaction: `{ password: 'x', nested: { api_key: 'y' } }` → both redacted; runs *before* buffering (assert buffer contents).
- Filter hook returning false drops; tag hook tags land in entry.
- Flush failure (store that throws) does not propagate.

### P1.4 Memory store

**Deliverables:** `src/storage/memory_store.ts` implementing the full `PeriscopeStore` interface (ring buffer, tag index as `Map<string, Set<uuid>>`). This is both the test double and a real shipping driver (useful for ephemeral CI debugging).

**Done when:** contract test suite `tests/storage/contract.ts` (a shared spec run against every driver — write it now, reuse in P2) passes against memory store: save/find/list-with-cursor/batch/prune/clear/monitoring/flags.

### P1.5 Config + `defineConfig`

**Deliverables:** `src/define_config.ts`, `stubs/config/periscope.stub` — full shape from architecture §9.4 with runtime validation (vine or hand-rolled) and resolved defaults.

**Done when:** invalid config (negative caps, unknown driver) fails at boot with a clear error; type tests lock the public config surface.

**🏁 Phase 1 demo:** a script in playground records 3 fake entries in a scope, flushes to memory store, prints the batch. Recursion/mute unit tests green.

---

## Phase 2 — Storage: Schema, Drivers, Pruning (est. 1 week)

### P2.1 Migration + Lucid `database` driver

**Deliverables:**
- `stubs/migrations/create_periscope_tables.stub` (schema from architecture §7.2; conditional `jsonb` vs `text` on client detection).
- `src/storage/database_store.ts` — uses `db.connection(config.storage.connection)` directly (query-builder, **no Lucid models** — avoids model-watcher self-recording and keeps Lucid optionality clean at this layer even though the driver requires Lucid).
- Batched inserts: one `insert` for entries (chunked at 200 rows), one for tags.
- `list()` implements cursor pagination on `sequence desc` with filters: `type`, `tag` (join), `familyHash`, `batchId`, `displayOnIndex`.

**Done when:** storage contract suite passes against sqlite + postgres in CI (docker service for PG); an EXPLAIN sanity test confirms the `(type, should_display_on_index)` index is used for the main list query on PG.

### P2.2 `sqlite-local` driver

**Deliverables:** `src/storage/sqlite_local_store.ts` — direct `better-sqlite3` (bundled dependency), file at `app.tmpPath('periscope.sqlite')`, WAL mode, schema auto-created on first open (no migration needed — this is the zero-config path). Synchronous better-sqlite3 calls are wrapped so `save()` runs in a `setImmediate` continuation (already off hot path via flush, but keep the interface async-honest).

**Done when:** contract suite passes; deleting the file and restarting recreates it; concurrent-process open doesn't corrupt (WAL smoke test).

### P2.3 Pruning + trim

**Deliverables:** prune implementations in both drivers (`created_at <` delete, `--keep-exceptions` predicate, cascade handles tags); `maxEntries` oldest-first trim invoked opportunistically at flush when `sequence` count exceeds cap (cheap check: every Nth flush).

**Done when:** tests seed 1k entries, prune by hours and by cap, assert exception preservation.

### P2.4 Driver resolution

**Deliverables:** `src/storage/resolve.ts` — maps config `driver` string to instance; throws helpful error if `database` chosen without Lucid installed.

**🏁 Phase 2 demo:** playground script writes batches through the recorder into sqlite-local; `sqlite3 tmp/periscope.sqlite 'select type,count(*) ...'` shows rows.

---

## Phase 3 — Watchers, Wave 1 (est. 1.5–2 weeks)

> Order matters: Request first (it creates batches), then Query/Exception/Log/Event. Each watcher = its own directory `src/watchers/{name}/` with `watcher.ts`, `types.ts` (content shape), tests.

### P3.1 Watcher registry

**Deliverables:** `src/watchers/registry.ts` — resolves enabled watchers from config, calls `register()`, collects `cleanup()` for shutdown/tests. Every registration wrapped in `safeguard()`.

### P3.2 RequestWatcher ⭐ (the keystone)

**Deliverables:**
- `src/watchers/request/middleware.ts` — server middleware, exported at `periscope/middleware/request_watcher`:

```ts
export default class PeriscopeMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (!recorder.enabled || isDashboardRequest(ctx)) return next()
    return BatchScope.run('request', () => next())
  }
}
```

- `src/watchers/request/watcher.ts` — listens `http:request_completed`, builds the primary `request` entry: method, url, matched route pattern + name, redacted headers, redacted parsed payload (`request.all()` — note v7 merges files in; store file metadata not contents), status, duration (from event hrtime), memory delta, content-type-gated response preview (JSON/text ≤ `sizeLimitKb`, captured via a response-body tap installed by the middleware), auth user summary if `ctx.auth?.user` exists, session snapshot if enabled.
- Auto-tags: `status:{code}`, `Auth:{id}` when authenticated, `slow` when duration > threshold.
- **Batch reunification problem:** `http:request_completed` listener runs in the request's async continuation, so `BatchScope.current()` resolves — but write a test proving it, and a fallback (WeakMap ctx→batchId populated by the middleware) if emittery ever detaches.

**Done when (integration, playground):** `GET /ok` produces exactly one request entry; `/boom` produces a request entry with 500 status; dashboard path requests produce zero entries; `POST /echo` payload shows `password: '[REDACTED]'`.

### P3.3 QueryWatcher

**Deliverables:** `src/watchers/query/watcher.ts`

- `emitter.on('db:query', handler)`; drop when `query.connection === periscopeConnection`.
- Content: sql, bindings (elided if `hideBindings`), connection, duration, `slow` flag; `familyHash = sha1(normalizeSql(sql))` (strip binding values/numbers) — powers n+1 grouping later.
- Dev-only caller capture: `Error.captureStackTrace` at record time, filtered to app frames (config `captureLocation: 'dev' | 'always' | 'never'`).
- Sub-entry: `hiddenFromIndex()` is **not** set (queries have their own index screen) — but tag with batch's request route for cross-filtering.
- Health signal: watcher exposes `stats.recorded`; the doctor (P7.4) compares against "requests happened but zero queries recorded" to warn about `debug: false`.

**Done when:** `/ok` batch contains its SELECT with duration; `/slow` query flagged `slow`; a flush-time storage insert produces zero query entries (recursion test — the marquee CI gate from here on).

### P3.4 ExceptionWatcher

**Deliverables:**
- `src/watchers/exception/mixin.ts` (`withPeriscope(ExceptionHandler)`) — overrides `report()` to record then `super.report()`. Content: class name, message, source-mapped stack (use `Error.prepareStackTrace`-safe parsing + `node:module` `findSourceMap`), code frame (dev only, read ±5 lines), request summary if in a request batch.
- `familyHash = sha1(class + message + topAppFrame)`.
- `src/watchers/exception/process.ts` — `uncaughtExceptionMonitor` + `unhandledRejection` observers (monitor variant: never alters semantics); these flush the ambient batch immediately after recording (process may die).

**Done when:** `/boom` yields exception entry sharing batchId with its request entry; two identical throws share familyHash; a synthetic unhandledRejection is captured in ambient batch.

### P3.5 LogWatcher

**Deliverables:** `src/watchers/log/watcher.ts` + `src/watchers/log/stream.ts` — a `pino.multistream` branch injected by the provider at logger construction (provider registers before app boot completes; document that apps constructing custom loggers must add the exported stream manually — provide `periscopeLogStream()` for that). Level filter from config (default `warn`). The internal `periscope.internal` logger channel is excluded by name.

**Done when:** `/fanout`'s `logger.warn` lands in the batch; `logger.info` doesn't (default level); Periscope's own internal error logs never appear (self-exclusion test).

### P3.6 EventWatcher

**Deliverables:** `src/watchers/event/watcher.ts` — `emitter.onAny`; ignore-list: names matching `/^(http|db|session|mail|cache|queued?|container_binding|periscope):/` + config `ignore` globs. Payload through `safeSerialize` (8 KB cap). Class-based events: record constructor name + serialized instance.

**Done when:** `/fanout`'s custom event is recorded with payload; `db:query` is not double-recorded as an event.

**🏁 Phase 3 demo:** hit all playground routes, dump sqlite: every route yields a coherent batch (request + queries + logs + events + exception where applicable). **This is the "engine works" milestone.**

---

## Phase 4 — Dashboard API + SPA MVP (est. 2 weeks; parallelizable with Phase 3 after P3.2)

### P4.1 JSON API

**Deliverables:** `src/http/routes.ts`, `src/http/controllers/*.ts`, `src/http/middleware/authorize.ts`

- Route group under `config.dashboard.path`, own middleware stack: `[authorize]` only (explicitly *not* the app's router middleware — register via `router.group().use()` on raw routes; document CSRF exemption need if @adonisjs/shield present → configure step adds the path to shield's ignore list in P5).
- Endpoints per architecture §8.1. `GET /api/entries?type=&tag=&family_hash=&cursor=&limit=` → `{ data, nextCursor }`. Entry payloads are `StoredEntry` verbatim (content is already redacted).
- `authorize` middleware: env-gate first (`enabledIn` + `PERISCOPE_ENABLED`), then `config.dashboard.authorize(ctx)`; 404 (not 403) when env-gated so production leaks nothing.
- Static serving: `GET :path` → `index.html`; `GET :path/assets/*` → files from `build/dashboard/` with `immutable` cache headers and path-traversal guard.

**Done when:** API contract tests cover every endpoint incl. auth failures; requesting the dashboard produces no recorded entries.

### P4.2 SPA foundation (`packages/dashboard`)

**Deliverables:** Vite + React + TypeScript + Tailwind; build emits into `packages/periscope/build/dashboard` (wired into package build). Router (hash or history under base path), API client with cursor pagination hook, layout: sidebar (entry types w/ counts), topbar (pause toggle, clear, search).

Shared UI primitives to build once: `EntryIndexTable` (generic, columns injected per type), `EntryDetailDrawer`, `JsonTree` (collapsible, copy button), `SqlBlock` (formatted via `sql-formatter`, bindings inline toggle), `StackTrace` (frames, app-frame highlighting, code frame block), `DurationBadge`, `StatusBadge`.

### P4.3 MVP screens (Requests, Queries, Exceptions)

- **Requests index:** method, path, status, duration, when; row → **Batch detail**: header card (url/route/user), tabs (Timeline | Headers | Payload | Response | Session), Timeline = all batch entries sorted by `sequence` with type icons — *this screen is the product; budget real polish time.*
- **Queries index:** sql preview, duration, slow filter toggle, connection; detail: formatted SQL, bindings, location, "N occurrences of this query shape in batch" (familyHash count) with n+1 hint badge when N ≥ config threshold.
- **Exceptions index:** grouped by familyHash (latest message, count, last seen); detail: stack, code frame, occurrences list, link to each batch.

**Done when:** manual QA script — run playground, click through all three screens against real data; Lighthouse a11y pass ≥ 90; works with 10k seeded entries (pagination perf).

### P4.4 Polling refresh

Simple 2.5 s polling on index screens with new-rows-pill ("12 new entries — click to load"), pause-aware. (SSE upgrades in P7.)

**🏁 Phase 4 demo:** full local loop — browse to `/periscope`, debug a `/boom` request end-to-end visually.

---

## Phase 5 — Packaging: configure, Commands, Provider Hardening (est. 1 week)

### P5.1 Provider finalization

**Deliverables:** `providers/periscope_provider.ts` per architecture §9.2, plus:
- Registers early so its shutdown (flushAll + ambient stop + watcher cleanup) runs **late** (v7 reverse-order shutdown).
- Environments: `['web', 'console', 'test']` gating logic (recording on in console for CommandWatcher later; dashboard routes only in `web`).
- Hard zero-cost path verified: with `enabled: false`, assert no listeners registered on emitter (test introspects listener counts).

### P5.2 `node ace add periscope` (configure.ts)

**Deliverables:** `configure.ts` using `@adonisjs/core` codemods API:

1. Prompt: storage driver (`sqlite-local` [default] / `database`). If `database`: prompt connection name, print snippet for `config/database.ts`.
2. Publish `config/periscope.ts` stub (driver choice baked in).
3. If `database`: publish migration stub.
4. `codemods.updateRcFile` → add provider.
5. `codemods.registerMiddleware('server', ...)` → insert request-watcher middleware **first** (verify ordering; if codemod can't guarantee position, insert + print manual-check warning).
6. Detect `@adonisjs/shield` → add dashboard path to CSRF exceptions (codemod or printed instruction).
7. Offer exception-handler mixin edit (string-transform on `app/exceptions/handler.ts` with dry-run diff; fallback to printed instructions on non-standard files).
8. Print post-install checklist: `debug: true` for Lucid, optional `periscopeDoctor()` hook, migration command if applicable.

**Done when:** an integration test runs configure against a pristine `create-adonisjs` v7 scaffold in CI and boots it green; re-running configure is idempotent.

### P5.3 Ace commands

**Deliverables:** `commands/prune.ts` (`periscope:prune --hours=48 --keep-exceptions`), `commands/clear.ts`, `commands/pause.ts` / `resume.ts` (writes `paused` flag → recorder checks flag with a 5 s cached read).

**Done when:** command tests via Ace kernel; paused flag actually stops recording within one cache window (integration).

**🏁 Phase 5 demo:** brand-new v7 app → `npm i periscope && node ace add periscope && node ace serve` → working dashboard in under 2 minutes. Record this as the README gif.

---

## Phase 6 — Watchers, Wave 2 (est. 1.5–2 weeks)

Each follows the P3 per-watcher pattern (dir, content types, unit + integration + recursion tests, dashboard screen via the generic `EntryIndexTable` + a type-specific detail panel).

### P6.1 CommandWatcher
Ace kernel lifecycle hooks; batch per command (`BatchScope.run('command', …)` wrapping execution — hook into kernel's execute path via the documented hooks, else a kernel decorator installed by the provider in console environment). Ignore `periscope:*` + config list. Output tail: ring-buffer last 4 KB of stdout via a logger tap, not stream patching, if feasible; otherwise omit output in v1 (decide in-task, don't block).

### P6.2 MailWatcher
`mail:sending/sent/queueing/queued` + queue-error event. Content: envelope, subject, rendered HTML (cap 256 KB), text alt; store `.eml`-able raw message when the driver exposes it. Dashboard: HTML preview iframe (sandboxed, CSP `sandbox` attr), ".eml download" endpoint (`GET /api/entries/:uuid/eml`).

### P6.3 CacheWatcher
Bentocache event bus (`@adonisjs/cache` emits bus events — subscribe via the cache service's events). Ops: hit/miss/set/delete/clear; values stored only when `captureValues: true` (default false; keys only).

### P6.4 ModelWatcher
Boot-path hook install on `BaseModel` (wrap `$boot` or use `compose`-time registration): append `afterCreate/afterUpdate/afterDelete` recording hooks to every model except Periscope internals (none exist — DB driver is query-builder-only, by P2.1 design). Dirty diff on updates behind `captureDirty` config; diff values pass redactor.

**Risk task:** Lucid internals may shift — pin an integration test against the actual Lucid version matrix (min supported + latest) in CI.

### P6.5 GateWatcher (Bouncer)
Wrap ability/policy execution: provider detects `@adonisjs/bouncer`, decorates the bouncer service's `allows/denies/authorize` (composition wrapper registered in container, not prototype patching if a container swap suffices). Content: ability name, result, user id, serialized args; `ignoreAbilities` config.

### P6.6 DumpWatcher + `dump()`
`src/dump.ts` export: `dump(...values)` → records `dump` entry (safeSerialize, caller file:line via stack) **only when** `dump-open` flag set (dashboard sets it on tab focus via `POST /api/flags`, clears on blur/timeout 30 s heartbeat). Returns first value for inline use: `const user = dump(await User.find(1))`.

### P6.7 HttpClientWatcher
`diagnostics_channel.subscribe('undici:request:create' | ':headers' | ':trailers' | 'undici:request:error')`; WeakMap request→partial entry; batch stamped at create; finalize at trailers/error. Redact query-string + auth headers. Skip requests to self dashboard/API (loopback guard by port+path).

**Done when (phase-wide):** playground exercises each watcher; every screen renders; recursion suite still green; total watcher registration time at boot < 50 ms (measured in CI).

---

## Phase 7 — Live Mode, Monitoring, Sampling, Doctor (est. 1 week)

### P7.1 SSE stream
`GET /api/stream` — server-sent events pushing `{type, uuid, indexRow}` on each flush (recorder emits internal `flushed` notification; the SSE controller fans out to connected clients, max 5, auth re-checked at connect). SPA: swap polling for SSE with polling fallback; "live" indicator dot.

### P7.2 Monitored tags
Dashboard UI on tag chips ("monitor this tag"); store methods already exist (P1.4/P2 contract). Recorder flush consults monitored set (cached 10 s): batch containing a monitored tag bypasses sampling drop.

### P7.3 Sampling + `keepAlways`
Implement `sampleRate` (decided at batch open, stored on context) and `keepAlways(batchView)` evaluated at flush with a cheap batch-view facade (`hasEntryOfType`, `hasTag`, `hasEntryWhere`). Document the production recipe (sample 1%, keep exceptions/slow/5xx) in README with copy-paste config.

### P7.4 `periscopeDoctor()` hook
`src/hooks/doctor.ts` for `adonisrc.ts` `hooks.init`: dev-only checks — migration present (database driver), Lucid `debug` flags vs QueryWatcher enabled, dashboard path route collision, middleware position (request watcher first), Node ≥ 24. Prints a compact table; never throws.

### P7.5 Dashboard: remaining index screens + global search
Generic screens for all wave-2 types via `registerEntryType` metadata (label, icon, index columns, detail component). Global search box: tag-search (`Auth:42`, `status:500`, free tag) hitting `/api/entries?tag=`.

**🏁 Phase 7 demo:** two browser windows — one clicking playground routes, one watching entries stream in live; monitor `Auth:1`, set sampleRate 0.05, verify monitored batches always appear.

---

## Phase 8 — Hardening, Performance, Security Review (est. 1 week)

### P8.1 Performance gate (CI benchmark job)
`tests/bench/overhead.bench.ts` using autocannon against playground `/ok`:
- Baseline (periscope disabled) vs enabled: p99 latency delta < 1 ms, throughput delta < 5 %.
- Memory: 10-minute soak at 200 rps, RSS growth < 30 MB (caps + trim working).
- Record-path micro-bench: `record()` < 20 µs median (mitata).
Fail CI on regression > 20 % vs stored baseline.

### P8.2 Security review checklist (executed, not aspirational)
- [ ] Path traversal tests on asset route (`/periscope/assets/../../config`…)
- [ ] Env-gated 404 in production mode (boot playground with `NODE_ENV=production`, assert dashboard absent, API absent, zero listeners unless opted in)
- [ ] Redaction fuzz: property-test that no configured deny-key survives at any nesting depth in stored content
- [ ] Mail preview iframe sandbox verified (script injection attempt in mail HTML doesn't execute)
- [ ] SSE auth re-validation; connection cap enforced
- [ ] Dependency audit clean; lint rule for no-outbound-network green

### P8.3 Failure-mode drills
Kill storage mid-flush (drop sqlite file / close PG) → app keeps serving, internal log line only. Malformed entries (circular, 10 MB payload, BigInt, Symbol keys) → serialized within caps, never throw.

### P8.4 Docs
- README: 2-minute quickstart (the P5 gif), production sampling recipe, watcher reference table with content shapes, extensibility guide (custom watcher, custom store, tag/filter hooks), FAQ (why no queries? → `debug: true`; why async ordering note).
- `CONTRIBUTING.md` incl. the invariants from §0.

---

## Phase 9 — Release & Post-1.0 Track (est. 3–4 days + ongoing)

### P9.1 Release engineering
- Version 0.1.0 → dogfood in 2–3 real apps ≥ 2 weeks → 1.0.0.
- `np`/changesets release flow; provenance-signed npm publish; `build/dashboard` verified present in the tarball by a pack-test in CI (classic packaging failure — gate it).
- Version support policy: track AdonisJS v7 minors; Lucid min-version matrix in CI.

### P9.2 Post-1.0 backlog (ordered, from architecture roadmap)
1. Job/Schedule watcher **adapters** (interface + `@rlanz/bull-queue` reference impl) — was deliberately deferred: queue ecosystem is pluggable and adapter interface benefits from 1.0 user feedback.
2. Redis & Session watchers (off-by-default ones).
3. n+1 detector heuristics surfaced as batch-level warnings (familyHash count ≥ threshold within batch → warning banner on request detail).
4. OpenTelemetry trace-id cross-link (read active span at batch open, store `traceId` in request content).
5. Batch export ("download this batch as JSON bundle") for bug reports.
6. Multi-app viewer.

---

## 10. Cross-Cutting Workstreams (run continuously)

| Workstream | Cadence | Gate |
|---|---|---|
| Recursion test suite (self-recording) | every PR after P2 | CI required |
| Storage contract suite across drivers | every PR | CI required |
| Playground manual QA script | every phase exit | checklist in PR template |
| Perf baseline | nightly after P8.1 | alert on >20 % regression |
| API contract snapshot (dashboard ↔ package) | every PR touching `src/http` | CI required |

---

## 11. Risk Register

| # | Risk | Likelihood | Impact | Mitigation | Trigger/fallback |
|---|---|---|---|---|---|
| R1 | Emittery async ordering causes entries to miss their batch flush | Med | Med | sequence-at-capture + setImmediate flush + straggler insert path (built in P1/P3) | If straggler rate > 1 % in dogfood, add `flushGraceMs` default > 0 |
| R2 | Lucid internals (model boot, db:query payload) shift across minors | Med | High for ModelWatcher | version-matrix CI (P6.4); model watcher isolated so it can be disabled without collateral | Ship 1.0 with ModelWatcher behind `experimental` flag if matrix is red |
| R3 | Middleware codemod can't guarantee first position | Low | Med | verify + warn in configure; doctor re-checks (P7.4) | Manual instruction path |
| R4 | pino multistream injection point unavailable for custom logger setups | Med | Low | exported `periscopeLogStream()` escape hatch + docs (P3.5) | — |
| R5 | better-sqlite3 native build friction on some platforms | Low | Med | prebuilt binaries via the package's own prebuilds; memory-store fallback with boot warning | Driver falls back gracefully, never blocks boot |
| R6 | Dashboard assets missing from published tarball | Low | High | pack-test in CI (P9.1) | — |
| R7 | Overhead unacceptable with Lucid `debug: true` in prod sampling setups | Med | Med | document clearly; QueryWatcher prod guidance; sampling keeps flush cheap | Add "query watcher off, requests only" prod preset |
| R8 | Scope creep into APM territory | Med | Med | Non-goals in architecture §1.2 quoted in CONTRIBUTING; roadmap discipline | — |

---

## 12. Dependency Graph & Suggested Schedule

```
P0 ──▶ P1 ──▶ P2 ──▶ P3.1 ─▶ P3.2 ─▶ P3.3/P3.4/P3.5/P3.6 (parallel)
                         │
                         └──▶ P4.1 ─▶ P4.2 ─▶ P4.3 ─▶ P4.4      (Dashboard track,
                                                                parallel to P3.3+)
P3 + P4 ──▶ P5 ──▶ P6.x (parallel among themselves) ──▶ P7 ──▶ P8 ──▶ P9
```

**Single developer (13-week nominal):**

| Weeks | Focus |
|---|---|
| 1 | Phase 0 + start Phase 1 |
| 2 | Finish Phase 1 |
| 3 | Phase 2 |
| 4–5.5 | Phase 3 |
| 5.5–7.5 | Phase 4 |
| 8 | Phase 5 |
| 9–10.5 | Phase 6 |
| 11 | Phase 7 |
| 12 | Phase 8 |
| 13 | Phase 9 / buffer |

**Two developers:** Dev A: P0–P3 → P5 → P6 (engine). Dev B: P4 from week 3 (against memory-store seeded API), then P7 UI + P6 screens. Converge weeks 7–8 for Phase 8. ≈ 8 weeks.

---

## 13. Definition of Done — 1.0

- [ ] `node ace add periscope` → working dashboard on a pristine v7 app in ≤ 2 min (CI-verified scaffold test)
- [ ] Watchers shipping & documented: request, query, exception, log, event, command, mail, cache, model, gate, dump, http-client
- [ ] Requests / Queries / Exceptions screens polished; generic screens for all other types; live SSE mode
- [ ] Sampling + keepAlways + monitored tags production recipe documented and tested
- [ ] Recursion, redaction-fuzz, path-traversal, env-gating, and pack-content tests green in CI
- [ ] Overhead budget met (p99 +<1 ms, record() <20 µs, bounded memory soak)
- [ ] Prune/clear/pause commands; maxEntries trim; doctor hook
- [ ] README + extensibility docs; dogfooded ≥ 2 weeks in ≥ 2 real applications
