import { CircleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'

import { diffEntryContent } from '@/components/entry-compare-logic'
import type { EntryContentDiff } from '@/components/entry-compare-logic'
import { JsonTree } from '@/components/json-tree'
import { Well } from '@/components/instrument'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { StoredEntry } from '@/types'

type CompareState =
  | { status: 'loading' }
  | { status: 'ready'; left: StoredEntry; right: StoredEntry }
  | { status: 'error'; error: Error }

const DIFF_TONE: Record<EntryContentDiff['status'], string> = {
  changed: 'bg-sig-warn/10',
  'left-only': 'bg-sig-error/10',
  'right-only': 'bg-sig-ok/10',
  same: '',
}

const DIFF_TEXT: Record<EntryContentDiff['status'], string> = {
  changed: 'text-sig-warn',
  'left-only': 'text-sig-error',
  'right-only': 'text-sig-ok',
  same: 'text-ink-4',
}

export function EntryCompare({
  leftUuid,
  onOpenChange,
  open,
  rightUuid,
}: {
  leftUuid: string
  onOpenChange: (open: boolean) => void
  open: boolean
  rightUuid: string
}) {
  const [state, setState] = useState<CompareState>({ status: 'loading' })
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setState({ status: 'loading' })
    Promise.all([
      api.getEntry(leftUuid, controller.signal),
      api.getEntry(rightUuid, controller.signal),
    ])
      .then(([left, right]) => setState({ left, right, status: 'ready' }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setState({
          error: cause instanceof Error ? cause : new Error('Unable to compare these entries'),
          status: 'error',
        })
      })
    return () => controller.abort()
  }, [leftUuid, open, retry, rightUuid])

  const diff =
    state.status === 'ready' ? diffEntryContent(state.left.content, state.right.content) : []

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="w-full bg-chassis min-[900px]:max-w-5xl" side="right">
        <SheetHeader className="shrink-0 border-b border-edge bg-panel px-4 py-3">
          <SheetTitle className="text-md text-ink">Compare entries</SheetTitle>
          <SheetDescription className="text-xs text-ink-3">
            Content keys are aligned. Signal tint marks changed or missing values.
          </SheetDescription>
        </SheetHeader>
        <SheetPanel className="bg-chassis p-4">
          {state.status === 'loading' && (
            <div
              aria-busy="true"
              aria-label="Loading entry comparison"
              aria-live="polite"
              className="grid gap-3 min-[900px]:grid-cols-2"
              role="status"
            >
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-48 w-full min-[900px]:col-span-2" />
            </div>
          )}

          {state.status === 'error' && (
            <div className="well space-y-3 bg-sig-error/10 p-4" role="alert">
              <div className="flex items-start gap-2 text-sm text-sig-error">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{state.error.message}</span>
              </div>
              <Button onClick={() => setRetry((value) => value + 1)} size="sm" variant="outline">
                Try again
              </Button>
            </div>
          )}

          {state.status === 'ready' && (
            <div className="space-y-3">
              <div className="grid gap-2 min-[900px]:grid-cols-2">
                <Well className="num min-w-0 p-3">
                  <p className="break-all text-xs font-medium text-ink">{state.left.uuid}</p>
                  <p className="mt-1 text-micro text-ink-3">{state.left.type}</p>
                </Well>
                <Well className="num min-w-0 p-3">
                  <p className="break-all text-xs font-medium text-ink">{state.right.uuid}</p>
                  <p className="mt-1 text-micro text-ink-3">{state.right.type}</p>
                </Well>
              </div>

              {diff.map((row) => (
                <section className="border-t border-edge pt-3" key={row.key}>
                  <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
                    <h3 className="num min-w-0 break-all text-xs font-medium text-ink-2">
                      {row.key}
                    </h3>
                    {row.status !== 'same' && (
                      <span className={cn('shrink-0 text-xs', DIFF_TEXT[row.status])}>
                        {row.status.replace('-', ' ')}
                      </span>
                    )}
                  </div>
                  <div className="grid gap-2 min-[900px]:grid-cols-2">
                    <div className={cn('min-w-0 rounded-sm p-0.5', DIFF_TONE[row.status])}>
                      {row.status === 'right-only' ? (
                        <Well className="num flex min-h-16 items-center p-3 text-xs text-ink-4">
                          Not present
                        </Well>
                      ) : (
                        <JsonTree label={`${row.key} in ${state.left.uuid}`} value={row.left} />
                      )}
                    </div>
                    <div className={cn('min-w-0 rounded-sm p-0.5', DIFF_TONE[row.status])}>
                      {row.status === 'left-only' ? (
                        <Well className="num flex min-h-16 items-center p-3 text-xs text-ink-4">
                          Not present
                        </Well>
                      ) : (
                        <JsonTree label={`${row.key} in ${state.right.uuid}`} value={row.right} />
                      )}
                    </div>
                  </div>
                </section>
              ))}
            </div>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  )
}
