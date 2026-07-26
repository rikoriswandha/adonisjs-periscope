/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * The JSON-representable event detail handed to the recorder. `payload` is typed as unknown at
 * this boundary because {@link safeSerialize} preserves useful application shapes while
 * replacing values JSON cannot carry with explicit markers.
 */
export type EventEntryContent = {
  name: string
  payload: unknown
  isClassEvent: boolean
  className?: string
  listenerCount?: number
}
