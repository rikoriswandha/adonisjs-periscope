# Batch export format

Periscope batch exports are portable JSON documents for moving a recorded bug-report batch into another Periscope installation. The current schema is **v1**.

## Producing and importing an export

Export a recorded batch to a file:

```sh
node ace periscope:export --batch <id> --out periscope-batch.json
```

Import it into the durable store configured by the local application:

```sh
node ace periscope:import --file periscope-batch.json
```

Pass `--file -` to read JSON from standard input. Pass `--application <name>` to replace the application on every imported entry. Imported entries retain their original `uuid` and `batchId`, preserving batch navigation and export provenance, but receive fresh `sequence` values so they appear among the newest dashboard entries.

Re-importing the same export is detected up front: entries whose `uuid` already exists in the store are skipped and reported, and an import in which every entry already exists fails with an explicit error instead of silently writing nothing.

## Version 1 envelope

```json
{
  "format": "periscope.batch",
  "version": 1,
  "batchId": "01J...",
  "application": "my-app",
  "entries": []
}
```

| Field         | Type   | Description                                                                                |
| ------------- | ------ | ------------------------------------------------------------------------------------------ |
| `format`      | string | Format discriminator. It must be exactly `periscope.batch`.                                |
| `version`     | number | Schema version. Version 1 is the only currently supported value.                           |
| `batchId`     | string | Identifier of the exported batch.                                                          |
| `application` | string | Application recorded on the exported batch and the default application used during import. |
| `entries`     | array  | Recorded entries in transport form, described below.                                       |

## Entry transport shape

Each object in `entries` has these fields:

| Field                  | Type                   | Description                                                                                                                                                        |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uuid`                 | string                 | Stable entry identifier. It is preserved during import.                                                                                                            |
| `batchId`              | string                 | Batch identifier attached to the entry. It is preserved during import.                                                                                             |
| `application`          | string                 | Application that recorded the entry. `--application` can override it during import.                                                                                |
| `type`                 | string                 | Entry type. The catalogue is open, so import accepts watcher types unknown to the importing release.                                                               |
| `familyHash`           | string or null         | Correlation hash used to group related entries, or `null` when the entry has none.                                                                                 |
| `content`              | JSON value             | Watcher-specific recorded payload.                                                                                                                                 |
| `tags`                 | array of strings       | Tags attached after recording hooks ran.                                                                                                                           |
| `shouldDisplayOnIndex` | boolean                | Whether the entry is eligible for the dashboard index.                                                                                                             |
| `sequence`             | decimal integer string | The original bigint ordering key, encoded as a string because JSON cannot represent bigint. Import validates it, then assigns a fresh sequence for local ordering. |
| `createdAt`            | ISO 8601 string        | The entry timestamp, emitted in JavaScript `Date#toISOString()` form and revived as a `Date` during import.                                                        |

## Versioning and validation

Consumers must check both `format` and `version` before reading entries. Periscope rejects unknown formats and unknown versions rather than guessing how to interpret them. A future incompatible schema will use a new integer version.

Import also validates the envelope and every entry before writing anything. Invalid dates, sequence strings, field types, or missing required fields cause the whole import to fail.

## Sensitive data and redaction

An export contains whatever Periscope stored after its configured redaction hooks ran. Exporting does not perform an additional redaction pass. Review and handle export files as potentially sensitive bug-report artifacts, especially when recording configuration allowed request bodies, headers, application payloads, or custom watcher content.
