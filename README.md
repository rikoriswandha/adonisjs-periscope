# Periscope

Periscope is a Laravel-Telescope-style debug assistant for AdonisJS v7. It records what an
application actually did — HTTP requests, database queries, exceptions, logs, events, mail, jobs —
correlates each one into the batch that produced it, and serves the result from a local dashboard
SPA mounted inside the app. It is a development and staging tool, not an APM: everything stays on
the machine, and the package makes no outbound network calls.

## Layout

This repository is an npm workspaces monorepo.

| Path | Package | Description |
| --- | --- | --- |
| `packages/periscope` | `periscope` | The publishable package: provider, recorder, watchers, storage drivers, dashboard HTTP API. |
| `packages/dashboard` | `@periscope/dashboard` | Private. Vite + React SPA; builds into `packages/periscope/build/dashboard`. |
| `playground` | `playground` | Private. Fixture AdonisJS v7 app used for integration tests and manual QA. |

## Requirements

- Node.js >= 24
- npm 11 or newer (workspaces, and the `allow-scripts` policy in `.npmrc`)

## Commands

Run from the repository root.

| Command | What it does |
| --- | --- |
| `npm install` | Install every workspace. Runs native install scripts (`better-sqlite3`). |
| `npm run build` | Build `periscope`, then the dashboard SPA into `packages/periscope/build/dashboard`. |
| `npm run dev` | Run the playground migrations, then boot it with HMR. |
| `npm test` | Package unit tests, then playground integration tests. |
| `npm run lint` | ESLint across all workspaces. |
| `npm run typecheck` | `tsc --noEmit` across all workspaces. |

## Status

**Status: Phase 0 — scaffold only.** No watchers, storage, or dashboard UI yet; see
`docs/IMPLEMENTATION_PLAN.md`.

## License

MIT
