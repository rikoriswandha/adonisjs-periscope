# Periscope

Periscope is a Laravel-Telescope-style debug assistant for AdonisJS v7. It records what an
application actually did — HTTP requests, database queries, exceptions, logs, events, commands,
mail, cache, model changes, authorization checks, dumps, and outbound HTTP calls — correlates each
one into the batch that produced it, and serves the result from a local dashboard
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

**Phases 0–7 complete.** The recorder, storage drivers, watcher set, dashboard API and SPA,
installer, Ace commands, live stream, monitoring, sampling, and doctor hook run end to end. See
`docs/IMPLEMENTATION_PLAN.md` for the remaining hardening and release work.

The dashboard provides dedicated request, query, and exception workflows plus registry-driven
screens for command, mail, cache, model, gate, dump, and outbound HTTP entries. Live mode uses an
authenticated server-sent event stream with polling fallback. Tag chips can be monitored so a
matching batch survives sampling.

The request middleware must remain **first** in `start/kernel.ts`'s `server.use([...])`; it opens
the batch every other watcher records into. Queries additionally need `debug: true` on the Lucid
connection so Lucid emits `db:query`. Add `periscopeDoctor()` to `adonisrc.ts` `hooks.init` to
check both settings, migrations, dashboard route collisions, and the Node.js version during
development.

## Production sampling

Production recording is opt-in. A useful baseline samples 1% of batches while always retaining
exceptions, slow work, and 5xx responses:

```ts
import { defineConfig } from 'periscope/periscope_config'

export default defineConfig({
  enabledIn: ['development', 'test', 'production'],
  recording: {
    sampleRate: 0.01,
    keepAlways: (batch) =>
      batch.hasEntryOfType('exception') ||
      batch.hasTag('slow') ||
      batch.hasEntryWhere(
        (entry) =>
          entry.type === 'request' &&
          typeof entry.content.status === 'number' &&
          entry.content.status >= 500
      ),
  },
})
```

Monitoring a tag in the dashboard also retains every matching batch, independently of
`sampleRate`. Recorded content remains local; Periscope makes no outbound network calls.

## License

MIT
