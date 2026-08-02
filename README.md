# Periscope

Periscope is a Laravel Telescope-style runtime recorder and local dashboard for AdonisJS v7. It correlates HTTP requests, database queries, exceptions, logs, events, jobs, mail, cache operations, and other application work without sending telemetry to an external service.

Periscope is intended for development and staging diagnostics, not as an APM or production tracing backend. Recorded values remain in the configured local store.

## Documentation

Read the complete documentation at [rikoriswandha.github.io/adonisjs-periscope](https://rikoriswandha.github.io/adonisjs-periscope/).

- [Get started](https://rikoriswandha.github.io/adonisjs-periscope/get-started)
- [Dashboard and security](https://rikoriswandha.github.io/adonisjs-periscope/guides/dashboard)
- [Watcher reference](https://rikoriswandha.github.io/adonisjs-periscope/guides/watchers)
- [Operations](https://rikoriswandha.github.io/adonisjs-periscope/guides/operations)
- [Testing](https://rikoriswandha.github.io/adonisjs-periscope/guides/testing)
- [Architecture](https://rikoriswandha.github.io/adonisjs-periscope/reference/architecture)
- [HTTP API](https://rikoriswandha.github.io/adonisjs-periscope/reference/http-api)
- [Adapter authoring](https://rikoriswandha.github.io/adonisjs-periscope/reference/adapters)

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
