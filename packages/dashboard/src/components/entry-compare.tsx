import { CircleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'

import { JsonTree } from '@/components/json-tree'
import { diffEntryContent } from '@/components/entry-compare-logic'
import type { EntryContentDiff } from '@/components/entry-compare-logic'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
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
import type { StoredEntry } from '@/types'

type CompareState =
  | { status: 'loading' }
  | { status: 'ready'; left: StoredEntry; right: StoredEntry }
  | { status: 'error'; error: Error }

const DIFF_TONE: Record<EntryContentDiff['status'], string> = {
  'changed': 'border-amber-500/30 bg-amber-500/8',
  'left-only': 'border-destructive/30 bg-destructive/6',
  'right-only': 'border-emerald-500/30 bg-emerald-500/8',
  'same': 'border-border bg-background',
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
      <SheetPopup className="w-full sm:max-w-5xl" side="right">
        <SheetHeader className="p-4 sm:p-5">
          <SheetTitle>Compare entries</SheetTitle>
          <SheetDescription>
            Content keys are aligned side by side. Highlighted rows are missing from one entry or
            contain different values.
          </SheetDescription>
        </SheetHeader>
        <Separator />
        <SheetPanel className="p-4 sm:p-5">
          {state.status === 'loading' && (
            <div
              aria-busy="true"
              aria-label="Loading entry comparison"
              className="space-y-3"
              role="status"
            >
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}

          {state.status === 'error' && (
            <div
              className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4"
              role="alert"
            >
              <div className="flex items-start gap-2 text-sm text-destructive-foreground">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{state.error.message}</span>
              </div>
              <Button onClick={() => setRetry((value) => value + 1)} size="sm" variant="outline">
                Try again
              </Button>
            </div>
          )}

          {state.status === 'ready' && (
            <div className="min-w-160 space-y-2 overflow-x-auto">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border bg-muted/35 p-3">
                  <p className="font-mono text-xs font-medium">{state.left.uuid}</p>
                  <p className="mt-1 text-2xs text-muted-foreground">{state.left.type}</p>
                </div>
                <div className="rounded-md border bg-muted/35 p-3">
                  <p className="font-mono text-xs font-medium">{state.right.uuid}</p>
                  <p className="mt-1 text-2xs text-muted-foreground">{state.right.type}</p>
                </div>
              </div>
              {diff.map((row) => (
                <section className={`rounded-md border p-2 ${DIFF_TONE[row.status]}`} key={row.key}>
                  <div className="mb-2 flex items-center justify-between gap-2 px-1">
                    <h3 className="font-mono text-xs font-semibold">{row.key}</h3>
                    {row.status !== 'same' && (
                      <span className="text-2xs font-medium uppercase text-muted-foreground">
                        {row.status.replace('-', ' ')}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {row.status === 'right-only' ? (
                      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                        Not present
                      </div>
                    ) : (
                      <JsonTree label={`${row.key} in ${state.left.uuid}`} value={row.left} />
                    )}
                    {row.status === 'left-only' ? (
                      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                        Not present
                      </div>
                    ) : (
                      <JsonTree label={`${row.key} in ${state.right.uuid}`} value={row.right} />
                    )}
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
