# Contributing to Periscope

Periscope runs inside the application it observes. Correctness includes preserving host behavior,
bounding diagnostic work, and failing closed at every exposure boundary. Changes that make the
recorder more observable but make the host less reliable are regressions.

## Set up the workspace

Requirements: Node.js 24 or newer and npm 11 or newer.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Do not use `--ignore-scripts`. `better-sqlite3` needs its native install script; `.npmrc` contains the
reviewed npm script allow-list.

The workspace has three parts:

- `packages/periscope`: the publishable AdonisJS provider, recorder, watchers, storage drivers,
  dashboard HTTP API, commands, and package tests.
- `packages/dashboard`: the private Vite/React dashboard. Its build output is copied into
  `packages/periscope/build/dashboard`.
- `playground`: the booted AdonisJS integration fixture used by functional and security checks.

`docs/IMPLEMENTATION_PLAN.md` records the staged architecture and acceptance criteria. Keep it as a
historical implementation record; describe current user-facing behavior in `README.md` and public
TypeScript documentation.

## Architecture and invariants

The runtime path is:

```text
host signal -> watcher -> IncomingEntry -> Recorder -> PeriscopeStore -> JSON/SSE API -> dashboard
```

Preserve these invariants:

1. **Recording is best effort.** A watcher, hook, serializer, flush listener, or store failure must
   never escape into an application request, event, command, logger, or shutdown path. Report it
   through the guarded internal logger instead.
2. **Disabled means inert.** The environment gate is evaluated before constructing a configured
   store or registering emitter, logger, process, model, or dashboard hooks.
3. **Correlation is batch-wide.** Request middleware must be first and must keep the `BatchScope`
   active around downstream work. Sampling is decided once per batch, not once per entry.
4. **Redact before buffering.** Application values pass through bounded serialization and recursive
   redaction before entering recorder memory. Never rely on display-time masking.
5. **Retention is bounded.** Per-batch caps and `storage.maxEntries` are hard limits. New code must
   not introduce an unbounded queue, cache, listener collection, response body, or traversal.
6. **Periscope never records itself.** Storage queries, internal logs, dashboard traffic, and
   Periscope commands are muted at their source or run in a muted batch scope.
7. **Storage behavior is portable.** `MemoryStore`, `SqliteLocalStore`, and `DatabaseStore` obey the
   same `PeriscopeStore` ordering, pagination, tag, flag, clear, prune, and close contracts.
8. **Authorization is per request.** Every dashboard JSON route and each SSE connection passes the
   environment gate and `dashboard.authorize`. A denied or disabled production request reveals no
   dashboard asset or API content.
9. **No outbound telemetry.** Shipped package source must not call `fetch`, `http`, `https`, Undici,
   sockets, or another network client. The HTTP watcher observes diagnostics channels only.
10. **Optional peers stay optional.** Watchers for Lucid, Mail, Cache, and Bouncer must load safely
    when those packages are absent.

## Code conventions

- Use the existing TypeScript and AdonisJS patterns; do not add a second abstraction for an
  established lifecycle or storage operation.
- Keep public exports explicit in `packages/periscope/package.json` and `src/index.ts`.
- Add TSDoc for public APIs and for non-obvious concurrency, lifecycle, or security decisions.
- Prefer synchronous work only when the dependency is synchronous and the operation is bounded.
  Yield before large SQLite write batches so recording does not monopolize the event loop.
- Use `safeguard` or `safeguardAsync` at host-application boundaries, not as a substitute for fixing
  internal programming errors.
- COSS primitives in `packages/dashboard/src/components/ui` are the dashboard component source of
  truth. Use COSS composition and accessibility behavior rather than introducing Radix/shadcn
  variants.
- Use the installed bklit chart particles for analytics visualizations. Do not add a second charting
  system.
- Keep controls keyboard-operable, label icon-only actions, preserve visible focus, and verify
  dialog, tabs, table, and responsive behavior in a real browser.

## Focused verification

Run the smallest command that exercises the changed contract while iterating:

```sh
# One package unit or storage test
npm -w adonisjs-periscope test -- --files="unit/recorder/redactor.spec.ts"
npm -w adonisjs-periscope test -- --files="storage/sqlite_local_store.spec.ts"

# Dashboard tests and build
npm -w @periscope/dashboard test
npm -w @periscope/dashboard run build

# Booted playground integration
npm -w adonisjs-periscope run build
npm -w playground run migrate
npm -w playground test

# Production gate and path traversal drill
npm run security:production

# Dependency advisory policy
npm run security:audit
```

Before opening a pull request, run the workspace commands from the setup section. A dashboard change
also requires browser verification against the booted playground; report the route, viewport, and
interaction exercised.

Tests must defend observable behavior and fail on a plausible regression. Prefer real store and
booted-application paths when the contract crosses those boundaries. Do not assert source text or
mock the behavior under test.

## Security review

Changes to capture, serialization, storage, dashboard routing, rendering, or dependencies must
answer all applicable checks:

- Can a nested or unusually shaped secret reach a buffer or persisted row before redaction?
- Can a hostile getter, cycle, BigInt, symbol, stream, binary value, or oversized payload hang or
  grow the process without a bound?
- Can an encoded path escape the built dashboard directory?
- Is the production gate evaluated before authorization, storage, and hook installation?
- Does every JSON and SSE request re-run authorization, and does the SSE connection cap still hold?
- Can recorded HTML execute script, navigate, submit a form, load a remote resource, or leak a
  referrer?
- Does package source introduce any outbound network capability?
- Does `npm run security:audit` pass, including its explicitly reviewed advisory list?

Never add a broad dependency-audit exception. `tests/security/dependency_audit.ts` allows one exact
advisory only when the vulnerable feature is unreachable in this client-only HashRouter SPA. Record
the advisory URL and the code-path rationale; remove the exception as soon as the dependency has a
compatible fixed release.

Report security issues privately to the maintainers rather than opening a public exploit issue.
Include affected versions, reproduction steps, impact, and any proposed mitigation.

## Performance gates

The benchmark compares compiled production playground processes with Periscope off and on, measures
the recorder hot path with Mitata, and runs a sustained fixed-rate soak:

```sh
npm run bench
```

Defaults are a 30-second throughput profile, paired five-rps latency probes, a 60-second soak
warmup, and a 10-minute soak at 200 requests per second. The benchmark preset keeps the request
watcher and recorder active, disables response/session capture and unrelated optional watchers,
uses the bounded memory store, and suppresses playground-only maintenance timers. Storage
persistence, all-watcher integration, and failure behavior have separate gates.

The p99 gate uses the median of repeated 50-sample paired p99 deltas; raw whole-run p99 values remain
in the output as diagnostics. Pairing and repetition keep unrelated scheduler/GC outliers from
being reported as package overhead. The hard gates are stored in
`packages/periscope/tests/bench/baseline.json` and currently require:

- `Recorder.record()` median below 20 microseconds.
- Added p99 latency below 1 millisecond.
- Throughput loss below 5 percent.
- RSS growth across the measured soak below 30 MiB.

Useful local overrides are:

```sh
PERISCOPE_BENCH_DURATION_SECONDS=10 \
PERISCOPE_SOAK_WARMUP_SECONDS=10 \
PERISCOPE_SOAK_SECONDS=30 \
PERISCOPE_BENCH_RPS=200 \
PERISCOPE_BENCH_LATENCY_RPS=15 \
PERISCOPE_SOAK_RPS=200 \
PERISCOPE_BENCH_CONNECTIONS=20 \
npm run bench
```

Do not weaken a threshold to make CI green. First reproduce on an otherwise idle machine, inspect
both raw baseline/enabled measurements, and fix the regression. A baseline update is acceptable
only for an intentional architecture or workload change; include before/after results, hardware and
Node version, the reason the old workload is no longer representative, and reviewer approval.

The scheduled CI job runs the full ten-minute soak. Pull requests run the correctness, type, lint,
build, security, and package-content gates; use the benchmark locally for changes on recorder,
request watcher, serialization, or storage hot paths.

## Pull requests

Keep a change reviewable and state:

- the user-visible or runtime contract changed;
- the invariants and failure modes considered;
- the exact focused and workspace commands run;
- browser evidence for dashboard changes;
- benchmark evidence for hot-path changes;
- documentation or public type/export changes.

Do not commit generated `build`, playground `tmp`, SQLite, coverage, or benchmark scratch files.
Dashboard assets are produced by the release build and verified from the package output.
