/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The DDL behind the `database` storage driver (implementation plan P2.1).
 *
 * This module exists so the shipped migration stub and everything that has to build the same
 * tables without a booted application — the driver's own test suite, most obviously — express
 * the schema exactly once. A migration is the natural home for DDL, but a migration is also the
 * one artefact nobody can execute without an `AceApplication`, a configured connection and the
 * Lucid migrator; duplicating the column list into a test helper would leave two definitions
 * free to drift, and the drift would only ever show up as a driver that passes its tests and
 * fails against a real application's tables.
 *
 * The functions take a `Knex.SchemaBuilder` rather than a query client on purpose. `BaseSchema`
 * hands out a *tracked* builder through `this.schema`, and only the calls made on that tracked
 * builder run inside the migration's transaction and show up under `migration:run --dry-run`.
 * Taking the builder as an argument is what lets the stub stay a normal, inspectable migration
 * while sharing its body with this module.
 *
 * Column choices — padded text `sequence`, epoch-millisecond `bigint` `created_at`, `0`/`1`
 * integer `should_display_on_index` — are explained in `./sql.ts`, which owns the codecs that
 * read and write them. This file only spells them in DDL; `./sql.ts` is the reason.
 */

import type { QueryClientContract } from '@adonisjs/lucid/types/database'

import {
  ENTRIES_TABLE,
  FLAGS_TABLE,
  MONITORED_TAGS_TABLE,
  TAGS_TABLE,
  TAG_INDEX_MAX_LENGTH,
} from './sql.ts'

/**
 * Lucid's schema builder, reached through the query client type rather than imported from knex
 * directly: `@adonisjs/lucid` is the optional peer this whole driver already depends on, and
 * borrowing the type from it keeps knex out of Periscope's declared type surface.
 */
export type PeriscopeSchemaBuilder = QueryClientContract['schema']

/**
 * Width of the flags table's `name` column. The same 191 as `TAG_INDEX_MAX_LENGTH`, and for the
 * same MySQL reason — it is a primary key, and `utf8mb4` stops indexing at 191 four-byte
 * characters — but spelled separately because a flag name is not a tag. Borrowing the tag index's
 * bound here would tie two unrelated columns together and make the next change to either one look
 * like it affected both.
 */
const FLAG_NAME_LENGTH = 191

/**
 * Create every Periscope table on the given schema builder.
 *
 * Knex accumulates statements on one builder and executes them in order, so the returned builder
 * covers all four tables; awaiting it runs the lot. The migration stub does not await it — it
 * hands the tracked builder back to `BaseSchema`, which awaits it for real.
 *
 * `content` and `tags` are TEXT on every dialect. That is a deliberate departure from the
 * implementation plan's "jsonb on postgres, text elsewhere", and the reason is that `jsonb`
 * parses what it is handed and rejects two escapes ordinary captured payloads contain: `\u0000`,
 * a NUL anywhere in a body, header or query string, and a lone surrogate such as `"\ud83d"`,
 * which is what redaction or truncation leaves behind after cutting an emoji in half. Postgres
 * answers both with `unsupported Unicode escape sequence` and fails the entire statement, so one
 * unlucky entry costs every entry batched with it — and the recorder's flush safeguard swallows
 * the error, so the batch simply vanishes. TEXT stores exactly the bytes `JSON.stringify`
 * produced and hands them back unchanged; `decodeJson` reads either shape, and the native type
 * was only ever buying indexing and pretty-printing that nothing in Periscope uses.
 *
 * The `'longtext'` argument is MySQL's alone: knex emits it for mysql2 and ignores it for pg and
 * better-sqlite3. MySQL's plain `TEXT` stops at 65 535 bytes and nothing bounds an entry's
 * content, so a large captured response would be truncated there and stored whole in `longtext`.
 */
export function createPeriscopeTables(schema: PeriscopeSchemaBuilder): PeriscopeSchemaBuilder {
  schema.createTable(ENTRIES_TABLE, (table) => {
    table.string('uuid', 36).notNullable().primary()
    table.string('batch_id', 36).notNullable()
    table.string('application', 191).notNullable().defaultTo('default')
    table.string('type', 32).notNullable()
    table.string('family_hash', 64).nullable()

    /*
     * JSON text, never a JSON column type — see the docblock for the two escapes `jsonb` refuses
     * and the whole-batch loss that refusal causes.
     */
    table.text('content', 'longtext').notNullable()
    table.text('tags', 'longtext').notNullable()

    /*
     * An integer, never a boolean: better-sqlite3 refuses to bind a JavaScript boolean and
     * postgres refuses to accept `0` for a boolean column, so an integer is the one encoding
     * both dialects take from the same code path.
     */
    table.integer('should_display_on_index').notNullable()

    table.string('sequence', 20).notNullable()
    table.bigint('created_at').notNullable()

    /*
     * Every index is named explicitly. Knex's generated names are derived from the table and
     * column list and differ subtly between dialects, and the EXPLAIN test that guards the list
     * query asserts on a name — an index Periscope cannot name is an index Periscope cannot
     * prove it is using.
     */
    table.index(['sequence'], 'periscope_entries_sequence_index')

    /*
     * The index the dashboard's main screen lives on: filter by type, keep only the entries a
     * watcher left visible, walk them newest-first. `sequence` trails the two equality columns
     * so the same index serves the ordering and the cursor's range scan.
     */
    table.index(
      ['type', 'should_display_on_index', 'sequence'],
      'periscope_entries_type_display_index'
    )
    table.index(
      ['application', 'type', 'should_display_on_index', 'sequence'],
      'periscope_entries_application_type_display_index'
    )
    table.index(['application', 'sequence'], 'periscope_entries_application_sequence_index')

    table.index(['batch_id', 'sequence'], 'periscope_entries_batch_id_index')
    table.index(['family_hash'], 'periscope_entries_family_hash_index')

    // Pruning's only predicate.
    table.index(['created_at'], 'periscope_entries_created_at_index')
  })

  schema.createTable(TAGS_TABLE, (table) => {
    /*
     * The foreign key is a safety net, not a mechanism. Both SQL drivers delete tag rows
     * explicitly, because SQLite only enforces foreign keys under `PRAGMA foreign_keys = ON` and
     * the `database` driver runs on a connection Periscope does not own and must not reconfigure.
     */
    table
      .string('entry_uuid', 36)
      .notNullable()
      .references('uuid')
      .inTable(ENTRIES_TABLE)
      .onDelete('CASCADE')

    table.string('tag', TAG_INDEX_MAX_LENGTH).notNullable()
    table.primary(['entry_uuid', 'tag'])
    table.index(['tag'], 'periscope_entry_tags_tag_index')
  })

  schema.createTable(MONITORED_TAGS_TABLE, (table) => {
    table.string('tag', TAG_INDEX_MAX_LENGTH).notNullable().primary()
  })

  schema.createTable(FLAGS_TABLE, (table) => {
    table.string('name', FLAG_NAME_LENGTH).notNullable().primary()
    table.text('value').notNullable()

    // Epoch milliseconds, nullable for a flag that never expires. Expiry is evaluated lazily on
    // read, so nothing sweeps this column.
    table.bigint('expires_at').nullable()
  })

  return schema
}

/**
 * Drop every Periscope table, children before parents so the foreign key above never blocks the
 * drop on a dialect that enforces it.
 *
 * `dropTableIfExists` rather than `dropTable`: a `down()` that has to run after a partially
 * applied `up()` is exactly the situation someone is in when they reach for it.
 */
export function dropPeriscopeTables(schema: PeriscopeSchemaBuilder): PeriscopeSchemaBuilder {
  schema.dropTableIfExists(TAGS_TABLE)
  schema.dropTableIfExists(ENTRIES_TABLE)
  schema.dropTableIfExists(MONITORED_TAGS_TABLE)
  schema.dropTableIfExists(FLAGS_TABLE)

  return schema
}
