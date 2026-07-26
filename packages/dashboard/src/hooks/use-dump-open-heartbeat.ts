import { useEffect } from 'react'

import { api } from '@/lib/api'
import { DUMP_OPEN_LEASE_FLAG as DUMP_OPEN_FLAG } from './dump-open-lease'

const HEARTBEAT_INTERVAL_MS = 10_000
let lifecycleGeneration = 0
let flagOpen = false

type RequestedFlagState = {
  open: boolean
  keepalive: boolean
  revision: number
}

let inFlight = false
let requested: RequestedFlagState = { open: false, keepalive: false, revision: 0 }

function reconcileFlag(): void {
  if (inFlight) return

  const snapshot = requested
  inFlight = true
  const operation = snapshot.open
    ? api.setFlag(DUMP_OPEN_FLAG)
    : api.deleteFlag(DUMP_OPEN_FLAG, { keepalive: snapshot.keepalive })

  void operation
    .catch(() => {
      // The next focus or heartbeat retries without surfacing recorder availability as page UI.
    })
    .finally(() => {
      inFlight = false
      if (snapshot.revision !== requested.revision) reconcileFlag()
    })
}

function requestFlagState(open: boolean, keepalive = false): void {
  requested = { open, keepalive, revision: requested.revision + 1 }
  reconcileFlag()
}

export function useDumpOpenHeartbeat(): void {
  useEffect(() => {
    lifecycleGeneration += 1
    let active = false
    let intervalId: number | undefined

    const clearHeartbeat = () => {
      if (intervalId === undefined) return
      window.clearInterval(intervalId)
      intervalId = undefined
    }

    const deactivate = (keepalive = false) => {
      flagOpen = false
      active = false
      clearHeartbeat()
      requestFlagState(false, keepalive)
    }

    const activate = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) {
        deactivate()
        return
      }
      if (active) return

      active = true
      if (!flagOpen) {
        flagOpen = true
        requestFlagState(true)
      }
      intervalId = window.setInterval(() => requestFlagState(true), HEARTBEAT_INTERVAL_MS)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') activate()
      else deactivate()
    }
    const handlePageHide = () => deactivate(true)
    const handleBlur = () => deactivate()

    window.addEventListener('focus', activate)
    window.addEventListener('blur', handleBlur)
    window.addEventListener('pagehide', handlePageHide)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    activate()

    return () => {
      window.removeEventListener('focus', activate)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('pagehide', handlePageHide)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      active = false
      clearHeartbeat()
      const cleanupGeneration = ++lifecycleGeneration
      queueMicrotask(() => {
        if (cleanupGeneration !== lifecycleGeneration || !flagOpen) return
        flagOpen = false
        requestFlagState(false, true)
      })
    }
  }, [])
}
