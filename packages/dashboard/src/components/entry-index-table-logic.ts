export type LiveTailQueueDecision = {
  paused: boolean
  queued: number
  shouldFlush: boolean
}

/**
 * Keeps pending rows outside the visible list until the viewport is back at the top. The pending
 * count remains owned by the polling hook so switching live tail off never loses queued entries.
 */
export function reconcileLiveTailQueue({
  atTop,
  enabled,
  pendingCount,
}: {
  atTop: boolean
  enabled: boolean
  pendingCount: number
}): LiveTailQueueDecision {
  const queued = enabled && !atTop ? pendingCount : 0
  return {
    paused: enabled && !atTop,
    queued,
    shouldFlush: enabled && atTop && pendingCount > 0,
  }
}
