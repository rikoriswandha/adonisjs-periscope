# Operating Periscope

Periscope is a development and staging diagnostic tool. This runbook covers durable shared stores,
retention, multi-process deployments, and the temporary production posture.

## Shared-store application scope

Set a stable and unique `applicationName` in every application that writes to the same database:

```ts
export default defineConfig({
  applicationName: 'billing-api',
  storage: {
    driver: 'database',
    connection: 'periscope',
    maxEntries: 50_000,
  },
})
```

The recorder stamps that value onto each entry's `application` field. Counts, entry queries,
exception groups, clears, prunes, and monitored tags accept an application scope. The monitored-tag
table uses `(application, tag)` as its primary key, so monitoring `slow` for `billing-api` does not
retain sampled-out batches from `identity-api`.

`storage.maxEntries` is a ceiling for the whole store, not a per-application quota. Size a shared
store for the combined traffic of every writer. Keep `applicationName` values and storage
connections consistent across deploys; changing a name creates a new logical application and leaves
the old rows under their previous scope.

## Retention and pruning

All stores trim their oldest rows when the shared `storage.maxEntries` ceiling is exceeded. Durable
stores can also prune by age:

```ts
storage: {
  driver: 'database',
  maxEntries: 50_000,
  retention: {
    hours: 48,
    keepExceptions: true,
    perType: {
      query: { hours: 12 },
      mail: { hours: 168 },
    },
  },
},
```

`retention.hours` is the default window. Each `retention.perType` entry replaces that window for
one entry type. `keepExceptions` takes precedence over both and prevents automatic deletion of
exception entries.

The provider schedules an immediate prune after boot and then every 15 minutes. Workers coordinate
with an expiring `maintenance-lease` store flag. The lease lasts two intervals and is best-effort,
not a distributed lock: two workers can race and prune concurrently. Pruning is idempotent, so this
only duplicates maintenance work. The timer and its initial run are unref'd, and shutdown waits for
an in-flight prune.

Automatic retention calls `prune` without an application scope. Applications sharing one store
should therefore use the same retention policy; the worker holding the lease applies its policy to
all entries. Use an application-scoped command when different teams need deliberate maintenance:

```sh
node ace periscope:prune --hours=24 --keep-exceptions --application=billing-api
node ace periscope:clear --application=billing-api
```

`periscope:prune` and `periscope:clear` require a durable driver. A scheduled prune is usually
unnecessary when `storage.retention` is configured. Before a broad clear or prune, confirm whether
other applications share the connection.

## Multi-process live updates

The default `dashboard.fanout` is an in-process listener list. An SSE client receives flush events
only from the worker that accepted its connection. `dashboard.sseMaxClients` is also enforced per
worker, so the effective cluster ceiling is the configured value multiplied by the worker count.
Stored history remains shared when workers use the same database; the limitation affects immediate
SSE notification, not later reads.

For cluster-wide live updates, provide a pub/sub-backed `FlushFanout` factory through
`dashboard.fanout`. Each worker must publish local flushes, subscribe to the common channel, return
idempotent unsubscribe functions, and release pub/sub resources from `close()`. See
[ADAPTERS.md](ADAPTERS.md#flush-fanout) for the contract and a skeleton.

If cluster-wide live updates are not required, leave the default in place. The dashboard's fallback
polling still discovers persisted entries, but notification latency can differ between workers.

## Control capture volume

The primary controls are:

- `recording.sampleRate`: fraction of batches retained, decided once when a batch opens. Every entry
  in a kept batch remains correlated.
- `recording.caps`: per-entry-type ceilings inside one batch. These bound a runaway request or job
  independently of store retention.
- watcher `enabled` and capture options: disabled watchers subscribe to nothing; payload, response,
  session, bindings, and value options reduce sensitive or expensive capture.
- `storage.maxEntries` and `storage.retention`: bound retained volume after recording.

Monitored tags and `recording.keepAlways` can override a sampled-out batch. A broad or common
monitored tag can therefore amplify storage volume far beyond the nominal `sampleRate`. Review the
monitored-tags screen whenever observed retention is higher than expected, and scope tags to the
intended application.

## Diagnostics

Run the installation doctor after upgrades or wiring changes:

```sh
node ace periscope:doctor
node ace periscope:doctor --fix
```

The command boots the application and checks Node.js, the database migration, Lucid query debug,
dashboard route collisions, request middleware ordering, provider ordering, the exception wrapper,
and Shield/CSRF compatibility. It exits with code 1 when a check fails. `--fix` only adds a missing
`debug: true` to Lucid connection objects it can edit conservatively; ambiguous configurations are
left unchanged.

The authorized `GET <dashboard.path>/api/status` response reports whether recording is enabled or
paused, the active application, applications present in the store, and store write diagnostics.
When the driver exposes diagnostics, inspect:

| Counter          | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `pendingBatches` | Accepted batches not yet durably written                 |
| `droppedBatches` | Batches dropped because the pending write queue was full |
| `failedBatches`  | Batches abandoned after the final write attempt failed   |
| `retriedBatches` | Save attempts that failed and were retried               |

The last three are monotonic for the lifetime of the process. Drivers without an asynchronous write
queue may return `store: null`. Sustained pending work or increasing loss counters calls for lower
capture volume and investigation of the storage path before increasing queue capacity.

## Temporary production recording

Periscope is off in production by default. If an incident requires temporary production recording,
combine explicit enablement, strict authorization, aggressive sampling, low caps, redaction, and
short retention:

```ts
import {
  DEFAULT_REDACT_HEADERS,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_VALUE_PATTERNS,
  REDACT_EMAIL_PATTERN,
  defineConfig,
} from '@rikology/adonisjs-periscope/periscope_config'

export default defineConfig({
  enabledIn: ['development', 'test', 'production'],

  storage: {
    driver: 'database',
    connection: 'periscope',
    maxEntries: 2_000,
    retention: { hours: 24, keepExceptions: true },
  },

  recording: {
    sampleRate: 0.01,
    caps: { default: 20, query: 50 },
    keepAlways: (batch) =>
      batch.hasEntryOfType('exception') ||
      batch.hasEntryWhere(
        (entry) => entry.type === 'request' && Number(entry.content.status) >= 500
      ),
  },

  redact: {
    keys: [...DEFAULT_REDACT_KEYS, 'tenantSecret'],
    headers: [...DEFAULT_REDACT_HEADERS],
    valuePatterns: [...DEFAULT_REDACT_VALUE_PATTERNS, REDACT_EMAIL_PATTERN],
  },

  watchers: {
    request: { captureResponse: false, captureSession: false, captureStatic: false },
    query: { hideBindings: true },
    command: { enabled: false },
    mail: { enabled: false },
    cache: { captureValues: false },
    model: { captureDirty: false },
    gate: { enabled: false },
    dump: { enabled: false },
    view: { enabled: false },
  },

  dashboard: {
    authorize: async ({ auth }) => {
      await auth.check()
      return auth.user?.isPeriscopeOperator === true
    },
  },
})
```

Set `PERISCOPE_ENABLED=true` only for the incident window. Monitor storage growth and the status
counters, then disable recording and clear retained data. Sampling is batch-wide; monitored tags
and `keepAlways` can still retain sampled-out batches.

Value-level redaction is on by default for bearer/JWT credentials, common `sk-`, `ghp_`, and `AKIA`
keys, password assignments, URL connection credentials, and Luhn-valid payment-card numbers. Email
redaction is opt-in through `REDACT_EMAIL_PATTERN`. Setting `valuePatterns: false` disables value
scanning but leaves key and header redaction in place. Individual strings above the serializer's
16 KiB default ceiling are not pattern-scanned, although deny-listed keys are still replaced
wholesale.
