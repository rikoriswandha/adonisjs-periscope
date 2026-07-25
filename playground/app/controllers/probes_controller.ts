import { setTimeout as sleep } from 'node:timers/promises'
import db from '@adonisjs/lucid/services/db'

import User from '#models/user'
import BoomException from '#exceptions/boom_exception'

/**
 * Row count walked by the `/slow` query. SQLite has no `sleep()`, so the query
 * burns time by doing real, fixed work instead of faking a delay: a recursive
 * CTE walks this many rows and hashes a random blob on each one.
 *
 * The *workload* is deterministic; the resulting wall-clock (~150 ms on a
 * modern laptop) is hardware dependent. That is good enough — Periscope only
 * needs the query to clear its "slow query" threshold, not to hit an exact
 * duration.
 */
const SLOW_QUERY_ITERATIONS = 150_000

const SLOW_QUERY = `WITH RECURSIVE seq(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < ?
)
SELECT count(*) AS rows_walked, sum(length(hex(randomblob(64)))) AS bytes_hashed FROM seq`

export default class ProbesController {
  /**
   * `GET /ok` — the happy path. One request, one real SELECT.
   */
  async ok() {
    const users = await User.all()
    return { users }
  }

  /**
   * `GET /slow` — 300 ms of wall-clock sleep outside the database plus one
   * genuinely expensive query. Gives the RequestWatcher a slow request and the
   * QueryWatcher a slow query in the same batch.
   */
  async slow() {
    await sleep(300)
    const result = await db.rawQuery(SLOW_QUERY, [SLOW_QUERY_ITERATIONS])

    return { sleptMs: 300, iterations: SLOW_QUERY_ITERATIONS, result }
  }

  /**
   * `GET /boom` — always throws a real 5xx exception.
   */
  boom(): never {
    throw new BoomException('The /boom route always explodes. That is its entire job.')
  }
}
