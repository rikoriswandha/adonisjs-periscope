/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import { safeguard } from './safeguard.ts'
import type { FlushFanout, FlushedEvent } from './types.ts'

/**
 * Build the single-process fanout used when an application has not supplied a distributed
 * adapter. A snapshot keeps publication stable when a listener unsubscribes itself, while the
 * safeguard prevents one dashboard connection from starving the listeners after it.
 */
export function createInProcessFanout(): FlushFanout {
  const listeners = new Set<(event: FlushedEvent) => void>()

  return {
    publish(event) {
      for (const listener of [...listeners]) {
        safeguard('periscope.fanout.publish', () => listener(event))
      }
    },

    subscribe(listener) {
      listeners.add(listener)
      let active = true

      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
      }
    },
  }
}
