---
'adonisjs-periscope': minor
---

Production-readiness hardening across security, durability, and packaging:

- **Security**: dashboard `authorize` now denies in production by default (override explicitly to enable); mutating dashboard endpoints (`/api/clear`, flags) require a dashboard header, same-origin Fetch Metadata, and a CSRF token when Shield is enabled; blanket Shield exemptions removed.
- **Redaction**: added value-level redaction with built-in secret patterns (bearer/JWT tokens, API keys, connection-string passwords, card numbers) applied to all captured content — query bindings, mail bodies, log messages, model attributes, gate users, response previews, and class-instance fields. Configurable via `redaction.valuePatterns`; set `false` to disable.
- **Durability**: recorder flushes no longer drop batches on failed saves (bounded retention and retry); database driver write backlog is bounded with oldest-drop backpressure; shutdown drains watcher-owned in-flight flushes; `maxEntries` is enforced as a hard ceiling on every flush; collision-safe composite `(sequence, uuid)` ordering across stores; SQLite uses WAL with a 100 ms busy timeout and creates database files with `0600` permissions.
- **Jobs**: BullMQ adapter readiness is time-bounded and `QueueEvents` are closed on teardown; job correlation map is bounded; exception-group pagination happens at the query level.
- **Packaging**: `prepack` now builds the package so direct workspace publishes ship a valid tarball; release workflow gated on CI; pack verification covers all export targets; bounded peer dependency ranges; complete npm metadata; corrected stubs.
