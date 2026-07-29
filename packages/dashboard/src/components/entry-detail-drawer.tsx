import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { CopyButton } from '@/components/copy-button'
import { EntryTagChips } from '@/components/tag-chip'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from '@/components/ui/sheet'
import type { StoredEntry } from '@/types'

export type EntryDetailPresentation = 'drawer' | 'page'

const EntryDetailContext = createContext<{
  entry: StoredEntry
  presentation: EntryDetailPresentation
} | null>(null)

export function EntryDetailScope({
  children,
  entry,
  presentation = 'drawer',
}: {
  children: ReactNode
  entry?: StoredEntry | null
  presentation?: EntryDetailPresentation
}) {
  if (!entry) return <>{children}</>
  return (
    <EntryDetailContext.Provider value={{ entry, presentation }}>
      {children}
    </EntryDetailContext.Provider>
  )
}

function hashUrl(path: string): string {
  const url = new URL(window.location.href)
  url.hash = path
  return url.toString()
}


function EntryDetailActions({ entry }: { entry: StoredEntry }) {
  return (
    <div aria-label="Share links" className="ms-auto flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-0.5 text-2xs text-muted-foreground">
        Entry
        <CopyButton
          label="Copy entry link"
          value={hashUrl(`/entries/${encodeURIComponent(entry.uuid)}`)}
        />
      </span>
      {entry.batchId && (
        <span className="flex items-center gap-0.5 text-2xs text-muted-foreground">
          Batch
          <CopyButton
            label="Copy batch link"
            value={hashUrl(`/requests/${encodeURIComponent(entry.batchId)}`)}
          />
        </span>
      )}
    </div>
  )
}

export function EntryDetailDrawer({
  open,
  onOpenChange,
  title,
  description,
  meta,
  tags,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  meta?: ReactNode
  tags?: readonly string[]
  children: ReactNode
}) {
  const context = useContext(EntryDetailContext)
  const [present, setPresent] = useState(false)

  useEffect(() => {
    if (!open) {
      setPresent(false)
      return
    }

    const frame = requestAnimationFrame(() => setPresent(true))
    return () => cancelAnimationFrame(frame)
  }, [open])

  const actions = context ? <EntryDetailActions entry={context.entry} /> : null
  const header = (
    <div className="space-y-2.5">
      <div className={context?.presentation === 'drawer' ? 'min-w-0 pe-10' : 'min-w-0'}>
        <h2 className="break-words font-mono text-base font-semibold leading-snug">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      {(meta || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {meta && <div className="flex flex-wrap items-center gap-1.5">{meta}</div>}
          {actions}
        </div>
      )}
    </div>
  )
  const panel = (
    <div className="space-y-4">
      {tags && <EntryTagChips tags={tags} />}
      {children}
    </div>
  )

  if (context?.presentation === 'page') {
    return (
      <section className="overflow-hidden rounded-lg border bg-card">
        <header className="p-4 sm:p-5">{header}</header>
        <Separator />
        <div className="p-4 sm:p-5">{panel}</div>
      </section>
    )
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={present}>
      <SheetPopup className="w-full sm:max-w-2xl" side="right">
        <SheetHeader className="p-4 sm:p-5">
          <SheetTitle className="sr-only">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
          {header}
        </SheetHeader>
        <Separator />
        <SheetPanel className="p-4 sm:p-5">{panel}</SheetPanel>
      </SheetPopup>
    </Sheet>
  )
}
