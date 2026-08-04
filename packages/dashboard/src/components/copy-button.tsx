import { Check, Clipboard, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

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
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)

    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('error')
    }

    timeoutRef.current = window.setTimeout(() => setState('idle'), 1_600)
  }

  const feedback = state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : label
  const Icon = state === 'copied' ? Check : state === 'error' ? TriangleAlert : Clipboard

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={state === 'idle' ? label : feedback}
              className={cn(
                'min-w-8 text-ink-3 active:bg-panel-raised',
                state === 'copied' && 'text-sig-ok',
                state === 'error' && 'text-sig-error'
              )}
              onClick={() => void copy()}
              size="sm"
              type="button"
              variant="ghost"
            />
          }
        >
          <Icon aria-hidden="true" className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>{feedback}</TooltipPopup>
      </Tooltip>
      <span aria-live="polite" className="sr-only" role="status">
        {state === 'idle' ? '' : feedback}
      </span>
    </>
  )
}
