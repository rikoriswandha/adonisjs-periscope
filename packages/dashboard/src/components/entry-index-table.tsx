import { ArrowDown, ArrowUp, CircleAlert, Columns2, Inbox, Pin, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { EntryCompare } from '@/components/entry-compare'
import { reconcileLiveTailQueue } from '@/components/entry-index-table-logic'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Frame, FramePanel } from '@/components/ui/frame'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import type { EntryMetadataRecord, StoredEntry } from '@/types'

export type EntryColumn = {
  key: string
  header: string
  className?: string
  primary?: boolean
  cell: (entry: StoredEntry) => ReactNode
}

export function EntryIndexTable({
  caption,
  columns,
  rows,
  loading,
  loadingMore,
  error,
  hasMore,
  onLoadMore,
  onRetry,
  onRowOpen,
  rowLabel,
  emptyTitle,
  emptyDescription,
  newCount = 0,
  onAcceptNew,
}: {
  caption: string
  columns: EntryColumn[]
  rows: StoredEntry[]
  loading: boolean
  loadingMore: boolean
  error: Error | null
  hasMore: boolean
  onLoadMore: () => void
  onRetry: () => void
  onRowOpen: (entry: StoredEntry) => void
  rowLabel: (entry: StoredEntry) => string
  emptyTitle: string
  emptyDescription: string
  newCount?: number
  onAcceptNew?: () => void
}) {
  const primaryColumnKey = columns.find((column) => column.primary)?.key ?? columns[0]?.key
  const [selected, setSelected] = useState<string[]>([])
  const [compareOpen, setCompareOpen] = useState(false)
  const [liveTail, setLiveTail] = useState(false)
  const [atTop, setAtTop] = useState(() => window.scrollY <= 24)
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [metadata, setMetadata] = useState<Map<string, EntryMetadataRecord>>(new Map())
  const [metadataLoading, setMetadataLoading] = useState(true)
  const [metadataError, setMetadataError] = useState<Error | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    api
      .fetchEntryMetadata(controller.signal)
      .then((records) => {
        setMetadata(new Map(records.map((record) => [record.uuid, record])))
        setMetadataError(null)
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setMetadataError(
          cause instanceof Error ? cause : new Error('Pinned entry metadata could not be loaded')
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setMetadataLoading(false)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const updatePosition = () => setAtTop(window.scrollY <= 24)
    updatePosition()
    window.addEventListener('scroll', updatePosition, { passive: true })
    return () => window.removeEventListener('scroll', updatePosition)
  }, [])

  const liveTailDecision = reconcileLiveTailQueue({
    atTop,
    enabled: liveTail,
    pendingCount: newCount,
  })

  useEffect(() => {
    if (liveTailDecision.shouldFlush) onAcceptNew?.()
  }, [liveTailDecision.shouldFlush, newCount, onAcceptNew])

  const visibleRows = useMemo(
    () => (pinnedOnly ? rows.filter((entry) => metadata.get(entry.uuid)?.pinned === true) : rows),
    [metadata, pinnedOnly, rows]
  )

  const toggleSelection = (uuid: string) => {
    setSelected((current) => {
      if (current.includes(uuid)) return current.filter((selectedUuid) => selectedUuid !== uuid)
      if (current.length === 2) return current
      return [...current, uuid]
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="flex min-h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-xs font-medium">
          Pinned
          <Switch
            aria-label="Show pinned entries only"
            checked={pinnedOnly}
            disabled={metadataLoading || metadataError !== null}
            onCheckedChange={setPinnedOnly}
          />
        </label>
        <label className="flex min-h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-xs font-medium">
          Live tail
          <Switch
            aria-label="Automatically show new entries"
            checked={liveTail}
            disabled={!onAcceptNew}
            onCheckedChange={setLiveTail}
          />
        </label>
      </div>

      {newCount > 0 && onAcceptNew && !liveTail && (
        <div className="flex justify-center">
          <Button
            className="font-mono text-xs tabular-nums"
            onClick={onAcceptNew}
            size="sm"
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" />
            {newCount} new {newCount === 1 ? 'entry' : 'entries'}
          </Button>
        </div>
      )}

      {metadataError && (
        <div
          className="rounded-md border bg-destructive/5 px-2.5 py-2 text-xs text-destructive-foreground"
          role="alert"
        >
          Pinned entries could not be loaded: {metadataError.message}
        </div>
      )}

      <Frame className="rounded-lg p-0.5">
        <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
          <div
            aria-busy={loading}
            aria-label={loading ? 'Loading entries' : undefined}
            className="overflow-x-auto"
            role={loading ? 'status' : undefined}
          >
            <Table className="min-w-data-table text-xs">
              <TableCaption className="sr-only">{caption}</TableCaption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 w-9 px-2">
                    <span className="sr-only">Select entries to compare</span>
                  </TableHead>
                  {columns.map((column) => (
                    <TableHead
                      className={`h-8 px-2.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase ${column.className ?? ''}`}
                      key={column.key}
                    >
                      {column.header || <span className="sr-only">Open details</span>}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading &&
                  Array.from({ length: 8 }, (_, index) => (
                    <TableRow key={index}>
                      <TableCell className="px-2 py-2">
                        <Skeleton className="size-3.5" />
                      </TableCell>
                      {columns.map((column) => (
                        <TableCell className="px-2.5 py-2" key={column.key}>
                          <Skeleton className="h-3.5 w-full max-w-36" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}

                {!loading &&
                  visibleRows.map((entry) => {
                    const isSelected = selected.includes(entry.uuid)
                    const pinned = metadata.get(entry.uuid)?.pinned === true
                    return (
                      <TableRow
                        className="cursor-pointer"
                        data-state={isSelected ? 'selected' : undefined}
                        key={entry.uuid}
                        onClick={() => onRowOpen(entry)}
                      >
                        <TableCell className="w-9 px-2 py-2">
                          <input
                            aria-label={`Select ${rowLabel(entry)} for comparison`}
                            checked={isSelected}
                            className="size-3.5 rounded border-border accent-primary"
                            disabled={!isSelected && selected.length >= 2}
                            onChange={() => toggleSelection(entry.uuid)}
                            onClick={(event) => event.stopPropagation()}
                            type="checkbox"
                          />
                        </TableCell>
                        {columns.map((column) => (
                          <TableCell
                            className={`px-2.5 py-2 ${column.className ?? ''}`}
                            key={column.key}
                          >
                            {column.key === primaryColumnKey ? (
                              <div className="flex items-center gap-2">
                                <button
                                  className="block min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                                  type="button"
                                >
                                  <span className="sr-only">{rowLabel(entry)}: </span>
                                  {column.cell(entry)}
                                </button>
                                {pinned && (
                                  <span className="shrink-0 text-primary" title="Pinned entry">
                                    <Pin aria-hidden="true" className="size-3.5 fill-current" />
                                    <span className="sr-only">Pinned</span>
                                  </span>
                                )}
                              </div>
                            ) : (
                              column.cell(entry)
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    )
                  })}
              </TableBody>
            </Table>
          </div>

          {!loading && error && rows.length === 0 && (
            <Empty className="border-0 py-12 md:py-14">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CircleAlert aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle className="text-base">Entries could not be loaded</EmptyTitle>
                <EmptyDescription>{error.message}</EmptyDescription>
              </EmptyHeader>
              <Button onClick={onRetry} size="sm" variant="outline">
                Try again
              </Button>
            </Empty>
          )}

          {!loading && !error && visibleRows.length === 0 && (
            <Empty className="border-0 py-12 md:py-14">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  {pinnedOnly ? <Pin aria-hidden="true" /> : <Inbox aria-hidden="true" />}
                </EmptyMedia>
                <EmptyTitle className="text-base">
                  {pinnedOnly ? 'No pinned entries' : emptyTitle}
                </EmptyTitle>
                <EmptyDescription>
                  {pinnedOnly
                    ? 'Pin an entry from its detail page to keep it available in this view.'
                    : emptyDescription}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {visibleRows.length > 0 && (
            <div className="flex items-center justify-between border-t bg-muted/40 px-2.5 py-1.5">
              <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                {visibleRows.length.toLocaleString()} loaded
                {pinnedOnly ? ' pinned' : ''}
              </span>
              {hasMore && (
                <Button loading={loadingMore} onClick={onLoadMore} size="xs" variant="ghost">
                  <ArrowDown aria-hidden="true" />
                  Older
                </Button>
              )}
            </div>
          )}
        </FramePanel>
      </Frame>

      {error && rows.length > 0 && (
        <div
          className="flex items-center justify-between rounded-md border bg-destructive/5 px-2.5 py-2 text-xs text-destructive-foreground"
          role="alert"
        >
          <span>{error.message}</span>
          <Button onClick={onRetry} size="xs" variant="ghost">
            Retry
          </Button>
        </div>
      )}

      {liveTailDecision.paused && (
        <Button
          className="fixed right-4 bottom-4 z-40 shadow-lg"
          onClick={() => window.scrollTo({ behavior: 'smooth', top: 0 })}
          size="sm"
          variant="secondary"
        >
          <ArrowUp aria-hidden="true" />
          Live tail paused
          {liveTailDecision.queued > 0 && ` · ${liveTailDecision.queued} queued`}
        </Button>
      )}

      {selected.length === 2 && (
        <>
          <Button
            className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 shadow-lg"
            onClick={() => setCompareOpen(true)}
            size="sm"
          >
            <Columns2 aria-hidden="true" />
            Compare
          </Button>
          <EntryCompare
            leftUuid={selected[0]}
            onOpenChange={setCompareOpen}
            open={compareOpen}
            rightUuid={selected[1]}
          />
        </>
      )}
    </div>
  )
}
