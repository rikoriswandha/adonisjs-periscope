/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { createHash } from 'node:crypto'

/**
 * Separator between hashed parts. `\u0000` cannot occur in a SQL string, an exception message or
 * a stack frame, so `familyHash('a', 'bc')` and `familyHash('ab', 'c')` cannot collide the way
 * they would with a printable joiner.
 */
const SEPARATOR = '\u0000'

/**
 * The grouping hash behind "these are the same thing": the same normalised SQL, the same
 * exception thrown from the same place.
 *
 * SHA-1 rather than SHA-256 because this is a grouping key, not a security boundary — it is
 * shorter in the index, faster to compute on the record path, and its collision story is
 * irrelevant when a collision means two query shapes share a dashboard row. `undefined` and
 * `null` parts are kept as empty strings rather than skipped, so a missing part still shifts the
 * hash instead of silently aliasing onto a shorter input.
 */
export function familyHash(...parts: (string | undefined | null)[]): string {
  return createHash('sha1')
    .update(parts.map((part) => part ?? '').join(SEPARATOR))
    .digest('hex')
}
