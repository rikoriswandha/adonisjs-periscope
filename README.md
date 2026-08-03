# Periscope

Periscope is a Laravel Telescope-style runtime recorder and local dashboard for AdonisJS v7. It correlates HTTP requests, database queries, exceptions, logs, events, jobs, mail, cache operations, and other application work without sending telemetry to an external service.

Periscope is intended for development and staging diagnostics, not as an APM or production tracing backend. Recorded values remain in the configured local store.

## Documentation

Read the complete documentation at [adonisjs-periscope.pages.dev](https://adonisjs-periscope.pages.dev/).

- [Get started](https://adonisjs-periscope.pages.dev/get-started)
- [Dashboard and security](https://adonisjs-periscope.pages.dev/guides/dashboard)
- [Watcher reference](https://adonisjs-periscope.pages.dev/guides/watchers)
- [Operations](https://adonisjs-periscope.pages.dev/guides/operations)
- [Testing](https://adonisjs-periscope.pages.dev/guides/testing)
- [Architecture](https://adonisjs-periscope.pages.dev/reference/architecture)
- [HTTP API](https://adonisjs-periscope.pages.dev/reference/http-api)
- [Adapter authoring](https://adonisjs-periscope.pages.dev/reference/adapters)

## Quickstart

```sh
npm install @rikology/adonisjs-periscope
node ace add @rikology/adonisjs-periscope
node ace serve --hmr
```

Open `/periscope`, generate application traffic, and run the installation doctor after configuration or wiring changes:

```sh
node ace periscope:doctor
```

Periscope requires Node.js 24 or newer and AdonisJS 7.

## Contributing

This repository is an npm workspace monorepo. See the [contribution guide](https://github.com/rikoriswandha/adonisjs-periscope/blob/main/CONTRIBUTING.md) for architecture invariants, focused verification commands, security review requirements, and benchmark gates.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

## License

MIT
