import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { CopyButton } from '@/components/copy-button'
import { StatusDot, statusSignal } from '@/components/instrument'
import type { Signal } from '@/components/instrument'
import { EntryTagChips } from '@/components/tag-chip'
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from '@/components/ui/sheet'
import { formatDateTime, formatRelativeTime } from '@/lib/format'
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

function entrySignal(entry: StoredEntry): Signal {
  const status = entry.content.status
  if (typeof status === 'number') return statusSignal(status)

  const normalized = typeof status === 'string' ? status.toLowerCase() : ''
  const level = typeof entry.content.level === 'string' ? entry.content.level.toLowerCase() : ''
  if (
    entry.type === 'exception' ||
    normalized.includes('fail') ||
    normalized.includes('error') ||
    level === 'error' ||
    level === 'fatal' ||
    entry.content.failed === true ||
    entry.content.error != null
  ) {
    return 'error'
  }
  if (
    normalized.includes('warn') ||
    normalized.includes('pending') ||
    normalized.includes('waiting') ||
    normalized.includes('denied') ||
    entry.content.allowed === false
  ) {
    return 'warn'
  }
  if (normalized.includes('complete') || normalized.includes('success') || normalized === 'sent') {
    return 'ok'
  }
  return 'neutral'
}

function EntryDetailActions({ entry }: { entry: StoredEntry }) {
  return (
    <div aria-label="Share links" className="ms-auto flex shrink-0 items-center gap-1">
      <CopyButton
        label="Copy entry link"
        value={hashUrl(`/entries/${encodeURIComponent(entry.uuid)}`)}
      />
      {entry.batchId && (
        <CopyButton
          label="Copy batch link"
          value={hashUrl(`/requests/${encodeURIComponent(entry.batchId)}`)}
        />
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

  const entry = context?.entry
  const header = (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 items-center gap-2 pe-10">
        {entry && <StatusDot signal={entrySignal(entry)} />}
        <span className="micro-label truncate text-ink-2">
          {entry?.type.replaceAll('_', ' ') ?? 'Entry'}
        </span>
        {entry && <EntryDetailActions entry={entry} />}
      </div>
      <div className="min-w-0">
        <h2 className="num break-all text-md leading-snug font-medium text-ink">{title}</h2>
        <p className="mt-1 break-words text-xs leading-5 text-ink-3">{description}</p>
      </div>
      {(entry || meta) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {entry && (
            <time className="num text-xs text-ink-2" dateTime={entry.createdAt}>
              {formatDateTime(entry.createdAt)}
            </time>
          )}
          {entry && (
            <span className="num text-xs text-ink-4">{formatRelativeTime(entry.createdAt)}</span>
          )}
          {meta && <div className="flex flex-wrap items-center gap-1.5">{meta}</div>}
        </div>
      )}
    </div>
  )
  const panel = (
    <div className="min-w-0 max-w-full space-y-4 max-sm:[&_[role=tablist]]:w-full max-sm:[&_[role=tablist]]:min-w-0 max-sm:[&_[role=tablist]]:overflow-x-auto">
      {tags && tags.length > 0 && <EntryTagChips tags={tags} />}
      {children}
    </div>
  )

  if (context?.presentation === 'page') {
    return (
      <section className="panel min-w-0 overflow-clip">
        <header className="sticky top-0 z-(--z-sticky) border-b border-edge bg-panel px-4 py-3">
          {header}
        </header>
        <div className="p-4">{panel}</div>
      </section>
    )
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={present}>
      <SheetPopup className="w-full bg-chassis max-sm:border-s-0 sm:max-w-2xl" side="right">
        <SheetHeader className="shrink-0 border-b border-edge bg-panel px-4 py-3">
          <SheetTitle className="sr-only">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
          {header}
        </SheetHeader>
        <SheetPanel className="min-w-0 bg-chassis p-3 sm:p-4">{panel}</SheetPanel>
      </SheetPopup>
    </Sheet>
  )
}
