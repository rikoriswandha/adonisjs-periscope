# Periscope

Periscope is a Laravel-Telescope-style debug assistant for AdonisJS v7. It records what an
application actually did — HTTP requests, database queries, exceptions, logs, events, mail, jobs —
correlates each one into the batch that produced it, and serves the result from a local dashboard
SPA mounted inside the app. It is a development and staging tool, not an APM: everything stays on
the machine, and the package makes no outbound network calls.

## Layout

This repository is an npm workspaces monorepo.

| Path                 | Package                | Description                                                                                 |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `packages/periscope` | `periscope`            | The publishable package: provider, recorder, watchers, storage drivers, dashboard HTTP API. |
| `packages/dashboard` | `@periscope/dashboard` | Private. Vite + React SPA; builds into `packages/periscope/build/dashboard`.                |
| `playground`         | `playground`           | Private. Fixture AdonisJS v7 app used for integration tests and manual QA.                  |

## Requirements

- Node.js >= 24
- npm 11 or newer (workspaces, and the `allow-scripts` policy in `.npmrc`)

## Commands

Run from the repository root.

| Command             | What it does                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ |
| `npm install`       | Install every workspace. Runs native install scripts (`better-sqlite3`).             |
| `npm run build`     | Build `periscope`, then the dashboard SPA into `packages/periscope/build/dashboard`. |
| `npm run dev`       | Run the playground migrations, then boot it with HMR.                                |
| `npm test`          | Package unit tests, then playground integration tests.                               |
| `npm run lint`      | ESLint across all workspaces.                                                        |
| `npm run typecheck` | `tsc --noEmit` across all workspaces.                                                |

## Status

**Phases 0–3 complete — the engine works, the dashboard does not exist yet.** See
`docs/IMPLEMENTATION_PLAN.md` for the full plan.

What runs today, end to end in the playground:

- **Recorder** — batch correlation across async boundaries, per-type caps, deep redaction, filter
  and tag hooks, a rotating ambient batch for everything outside a request.
- **Storage** — `memory`, `sqlite-local` (the zero-config default) and `database` (your own Lucid
  connection), all against one shared contract suite, with pruning and cap trimming.
- **Watchers, wave 1** — request, query, exception, log and event. Hit a route and the batch holds
  the request, its SQL, anything it logged at `warn` or above, the application events it emitted,
  and the exception it threw, all sharing one batch id.

Not yet: the dashboard API and SPA (phase 4), `node ace add periscope` and the ace commands
(phase 5), and the wave-2 watchers — command, mail, cache, model, gate, dump, http-client
(phase 6).

Two things an application has to do for wave 1 to see anything, both of which
`node ace add periscope` will do for you once phase 5 lands:

1. Register the request middleware **first** in `start/kernel.ts`'s `server.use([...])`. It opens
   the batch every other watcher records into.
2. Wrap the exception handler: `export default class HttpExceptionHandler extends
withPeriscope(ExceptionHandler) {}`, importing `withPeriscope` from
   `periscope/exception_reporter`.

Queries additionally need `debug: true` on the Lucid connection — that flag is what makes Lucid
emit the `db:query` event at all.

## License

MIT
