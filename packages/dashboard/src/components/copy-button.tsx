import { Check, Clipboard, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  const timeoutRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    },
    []
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('error')
    }
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = window.setTimeout(() => setState('idle'), 1_800)
  }

  const accessibleLabel =
    state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : label
  const Icon = state === 'copied' ? Check : state === 'error' ? TriangleAlert : Clipboard

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={accessibleLabel}
            onClick={() => void copy()}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <Icon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup>{accessibleLabel}</TooltipPopup>
    </Tooltip>
  )
}
