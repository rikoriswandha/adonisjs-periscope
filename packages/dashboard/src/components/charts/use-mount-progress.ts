'use client'

import { animate, type Transition, useMotionValue, useReducedMotion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { DEFAULT_CHART_ENTER_TRANSITION } from './animation'

/** Drives 0→1 enter progress using the studio motion transition (spring or tween). */
export function useMountProgress(
  enterTransition: Transition | undefined,
  delaySeconds: number,
  replayKey: number | string
) {
  const progress = useMotionValue(0)
  const reducedMotion = useReducedMotion()
  const transitionRef = useRef(enterTransition)
  transitionRef.current = enterTransition

  // replayKey intentionally retriggers enter when motion settings change
  // biome-ignore lint/correctness/useExhaustiveDependencies: replayKey
  useEffect(() => {
    if (reducedMotion) {
      progress.set(1)
      return
    }
    progress.set(0)
    const controls = animate(progress, 1, {
      ...(transitionRef.current ?? DEFAULT_CHART_ENTER_TRANSITION),
      delay: delaySeconds,
    })
    return () => controls.stop()
  }, [delaySeconds, reducedMotion, replayKey, progress])

  return progress
}
