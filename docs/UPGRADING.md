# Upgrading Periscope

## Database storage schema

Existing installations must add an `application varchar(191) NOT NULL DEFAULT 'default'` column to `periscope_monitored_tags` and replace its tag-only primary key with a composite primary key on `(application, tag)`. Existing rows remain in the `default` application scope.

Postgres installations may also enable `pg_trgm` and create the optional search index:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS periscope_entries_content_trgm
  ON periscope_entries USING gin (content gin_trgm_ops);
```

The generated migration attempts both operations but tolerates managed-database privilege restrictions. Without the extension or index, content search behavior is unchanged; PostgreSQL uses `ILIKE` and the planner may fall back to a table scan.
