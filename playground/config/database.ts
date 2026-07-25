import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/lucid'

const dbConfig = defineConfig({
  /**
   * Default connection used for all queries.
   */
  connection: 'sqlite',

  connections: {
    sqlite: {
      client: 'better-sqlite3',

      connection: {
        filename: app.tmpPath('db.sqlite3'),
      },

      /**
       * Load bearing: `debug: true` makes Lucid emit `db:query` for every query.
       * Periscope's QueryWatcher subscribes to that event, so the playground
       * would silently record zero queries without it.
       */
      debug: true,

      /**
       * Required by Knex for SQLite defaults.
       */
      useNullAsDefault: true,

      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },

      /**
       * Disabled: schema generation would write a `database/schema.ts` file and
       * force models to extend generated classes. The playground declares its
       * columns by hand instead.
       */
      schemaGeneration: {
        enabled: false,
      },
    },
  },
})

export default dbConfig
