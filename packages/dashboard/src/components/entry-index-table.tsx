import {
  ArrowDown,
  CircleAlert,
  Clipboard,
  Columns2,
  ExternalLink,
  Inbox,
  Pin,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

import { EntryCompare } from '@/components/entry-compare'
import { reconcileLiveTailQueue } from '@/components/entry-index-table-logic'
import { Panel, PanelHeader } from '@/components/instrument'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { EntryMetadataRecord, StoredEntry } from '@/types'

export type EntryColumn = {
  key: string
  header: string
  className?: string
  primary?: boolean
  cell: (entry: StoredEntry) => ReactNode
}

const MAGNITUDE_KEY = /duration|count|bytes|size|listeners|checks|arguments|changes|status/i
const NUMERIC_KEY = /duration|count|bytes|size|listeners|checks|arguments|changes|status|time|when|date|id|uuid|hash/i
const TIME_KEY = /^(when|time|createdAt|scheduledAt)$/i
const STATUS_KEY = /status|result|decision|level|state|kind|event|operation/i

function mobileRole(column: EntryColumn, primaryKey: string | undefined) {
  if (column.key === primaryKey) return 'primary'
  if (TIME_KEY.test(column.key)) return 'time'
  if (STATUS_KEY.test(column.key)) return 'status'
  return 'secondary'
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
  const displayColumns = useMemo(() => columns.filter((column) => column.key !== 'open'), [columns])
  const primaryColumnKey =
    displayColumns.find((column) => column.primary)?.key ?? displayColumns[0]?.key
  const firstStatusKey = displayColumns.find(
    (column) => column.key !== primaryColumnKey && STATUS_KEY.test(column.key)
  )?.key
  const panelRef = useRef<HTMLElement | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [compareOpen, setCompareOpen] = useState(false)
  const [searchParams] = useSearchParams()
  const liveTail = searchParams.get('tail') === '1'
  const [atTop, setAtTop] = useState(true)
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [metadata, setMetadata] = useState<Map<string, EntryMetadataRecord>>(new Map())
  const [metadataLoading, setMetadataLoading] = useState(true)
  const [metadataError, setMetadataError] = useState<Error | null>(null)
  const [pinning, setPinning] = useState<Set<string>>(new Set())

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
    const scrollContainer = panelRef.current?.closest('main') ?? window
    const updatePosition = () => {
      const top = scrollContainer instanceof Window ? scrollContainer.scrollY : scrollContainer.scrollTop
      setAtTop(top <= 24)
    }
    updatePosition()
    scrollContainer.addEventListener('scroll', updatePosition, { passive: true })
    return () => scrollContainer.removeEventListener('scroll', updatePosition)
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

  const togglePinned = async (entry: StoredEntry) => {
    if (pinning.has(entry.uuid)) return
    const current = metadata.get(entry.uuid)
    const pinned = !(current?.pinned ?? false)
    setPinning((value) => new Set(value).add(entry.uuid))
    setMetadataError(null)
    try {
      const record = await api.putEntryMetadata(entry.uuid, { pinned })
      setMetadata((value) => new Map(value).set(entry.uuid, record))
    } catch (cause: unknown) {
      setMetadataError(cause instanceof Error ? cause : new Error('The entry could not be pinned'))
    } finally {
      setPinning((value) => {
        const next = new Set(value)
        next.delete(entry.uuid)
        return next
      })
    }
  }

  const actionButtonClass =
    'relative inline-flex size-[var(--control-h)] items-center justify-center rounded-sm text-ink-3 transition-colors duration-[var(--dur-fast)] hover:bg-panel hover:text-ink active:bg-panel-raised disabled:pointer-events-none disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11'

  return (
    <div className="space-y-2">
      <Panel className="panel-flush" ref={panelRef}>
        <PanelHeader
          action={
            <label className="flex h-[var(--control-h)] items-center gap-2 rounded-sm border border-edge bg-well px-2 text-xs text-ink-2">
              Pinned
              <Switch
                aria-label="Show pinned entries only"
                checked={pinnedOnly}
                disabled={metadataLoading || metadataError !== null}
                onCheckedChange={setPinnedOnly}
              />
            </label>
          }
          meta={`${visibleRows.length.toLocaleString()} loaded${pinnedOnly ? ' pinned' : ''}`}
          title="Entries"
        />

        {metadataError && (
          <Alert className="m-2 rounded-sm" variant="error">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Pinned entries unavailable</AlertTitle>
            <AlertDescription>{metadataError.message}</AlertDescription>
          </Alert>
        )}

        <div
          aria-busy={loading}
          aria-label={loading ? 'Loading entries' : undefined}
          className="well rounded-none border-x-0 border-y-0"
          role={loading ? 'status' : undefined}
        >
          <Table
            className="min-w-data-table text-xs max-sm:min-w-0"
            render={<div className="relative w-full" style={{ overflow: 'visible' }} />}
          >
            <TableCaption className="sr-only">{caption}</TableCaption>
            <TableHeader className="sticky top-0 z-[var(--z-sticky)] bg-panel max-sm:hidden">
              <TableRow className="h-[var(--row-h)] border-edge hover:bg-panel">
                <TableHead className="h-[var(--row-h)] w-9 px-2" scope="col">
                  <span className="sr-only">Select entries to compare</span>
                </TableHead>
                {displayColumns.map((column) => (
                  <TableHead
                    className={cn(
                      'micro-label h-[var(--row-h)] bg-panel px-2.5 text-ink-3',
                      MAGNITUDE_KEY.test(column.key) && 'text-right',
                      column.className
                    )}
                    key={column.key}
                    scope="col"
                  >
                    {column.header}
                  </TableHead>
                ))}
                <TableHead className="micro-label h-[var(--row-h)] w-24 bg-panel px-2 text-right" scope="col">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {newCount > 0 && onAcceptNew && (!liveTail || liveTailDecision.paused) && (
                <TableRow className="sticky top-[var(--row-h)] z-[var(--z-sticky)] animate-slide-up border-edge bg-panel hover:bg-panel max-sm:top-0 max-sm:table-row">
                  <TableCell className="p-0 max-sm:table-cell" colSpan={displayColumns.length + 2}>
                    <button
                      className="flex h-[var(--row-h)] w-full items-center justify-center gap-2 rounded-none text-xs text-ink-2 transition-colors duration-[var(--dur-fast)] hover:bg-panel-raised hover:text-ink active:bg-panel disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11"
                      onClick={onAcceptNew}
                      type="reset"
                    >
                      <RefreshCw aria-hidden="true" className="size-3.5" />
                      <span className="num">{newCount.toLocaleString()}</span> new{' '}
                      {newCount === 1 ? 'entry' : 'entries'}
                    </button>
                  </TableCell>
                </TableRow>
              )}

              {loading &&
                Array.from({ length: 8 }, (_, index) => (
                  <TableRow
                    className="h-[var(--row-h)] border-edge max-sm:grid max-sm:min-h-[var(--row-h)] max-sm:grid-cols-[2rem_minmax(0,1fr)_5rem] max-sm:grid-rows-2 max-sm:items-center"
                    key={index}
                  >
                    <TableCell className="h-[var(--row-h)] px-2 py-[var(--cell-py)] max-sm:row-span-2">
                      <Skeleton className="size-3.5" />
                    </TableCell>
                    {displayColumns.map((column) => {
                      const role = mobileRole(column, primaryColumnKey)
                      return (
                        <TableCell
                          className={cn(
                            'h-[var(--row-h)] px-2.5 py-[var(--cell-py)]',
                            role === 'primary' &&
                              'max-sm:col-start-2 max-sm:row-start-1 max-sm:block',
                            role === 'status' &&
                              column.key === firstStatusKey &&
                              'max-sm:col-start-3 max-sm:row-start-1 max-sm:block',
                            role === 'time' &&
                              'max-sm:col-start-2 max-sm:row-start-2 max-sm:block max-sm:h-auto max-sm:py-0',
                            role === 'secondary' && 'max-sm:hidden',
                            role === 'status' && column.key !== firstStatusKey && 'max-sm:hidden'
                          )}
                          key={column.key}
                        >
                          <Skeleton className="h-3.5 w-full max-w-36" />
                        </TableCell>
                      )
                    })}
                    <TableCell className="h-[var(--row-h)] px-2 py-[var(--cell-py)] max-sm:hidden">
                      <Skeleton className="ms-auto h-5 w-16" />
                    </TableCell>
                  </TableRow>
                ))}

              {!loading &&
                visibleRows.map((entry) => {
                  const isSelected = selected.includes(entry.uuid)
                  const pinned = metadata.get(entry.uuid)?.pinned === true
                  return (
                    <TableRow
                      className="group h-[var(--row-h)] cursor-pointer border-edge transition-colors duration-[var(--dur-fast)] hover:bg-panel-raised focus-within:bg-panel-raised max-sm:grid max-sm:min-h-[var(--row-h)] max-sm:grid-cols-[2rem_minmax(0,1fr)_auto] max-sm:grid-rows-2 max-sm:items-center"
                      data-state={isSelected ? 'selected' : undefined}
                      key={entry.uuid}
                      onClick={() => onRowOpen(entry)}
                    >
                      <TableCell className="h-[var(--row-h)] w-9 px-2 py-[var(--cell-py)] max-sm:row-span-2">
                        <label
                          className="relative flex items-center justify-center pointer-coarse:size-11"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            aria-label={`Select ${rowLabel(entry)} for comparison`}
                            checked={isSelected}
                            className="size-3.5 rounded-sm border-edge accent-ink"
                            disabled={!isSelected && selected.length >= 2}
                            onChange={() => toggleSelection(entry.uuid)}
                            type="checkbox"
                          />
                        </label>
                      </TableCell>
                      {displayColumns.map((column) => {
                        const role = mobileRole(column, primaryColumnKey)
                        return (
                          <TableCell
                            className={cn(
                              'h-[var(--row-h)] min-w-0 px-2.5 py-[var(--cell-py)] text-ink-2',
                              NUMERIC_KEY.test(column.key) && 'num',
                              MAGNITUDE_KEY.test(column.key) && 'text-right',
                              role === 'primary' && 'max-sm:col-start-2 max-sm:row-start-1 max-sm:block max-sm:pr-1',
                              role === 'status' &&
                                column.key === firstStatusKey &&
                                'max-sm:col-start-3 max-sm:row-start-1 max-sm:block max-sm:px-2',
                              role === 'time' &&
                                'max-sm:col-start-2 max-sm:row-start-2 max-sm:block max-sm:h-auto max-sm:px-2.5 max-sm:py-0 max-sm:text-left max-sm:text-micro max-sm:text-ink-3',
                              role === 'secondary' && 'max-sm:hidden',
                              role === 'status' && column.key !== firstStatusKey && 'max-sm:hidden',
                              column.className
                            )}
                            data-mobile-role={role}
                            key={column.key}
                          >
                            {column.key === primaryColumnKey ? (
                              <button
                                className="block min-w-0 max-w-full truncate rounded-sm text-left outline-none pointer-coarse:min-h-11"
                                type="button"
                              >
                                <span className="sr-only">{rowLabel(entry)}: </span>
                                {column.cell(entry)}
                              </button>
                            ) : (
                              column.cell(entry)
                            )}
                          </TableCell>
                        )
                      })}
                      <TableCell className="h-[var(--row-h)] w-24 px-1.5 py-[var(--cell-py)] max-sm:col-start-3 max-sm:row-start-2 max-sm:block max-sm:w-auto max-sm:self-center max-sm:py-0">
                        <div className="flex justify-end gap-0.5 opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100">
                          <button
                            aria-label={`Open ${rowLabel(entry)}`}
                            className={actionButtonClass}
                            onClick={(event) => {
                              event.stopPropagation()
                              onRowOpen(entry)
                            }}
                            title="Open entry"
                            type="reset"
                          >
                            <ExternalLink aria-hidden="true" className="size-3.5" />
                          </button>
                          <button
                            aria-label={`Copy id for ${rowLabel(entry)}`}
                            className={actionButtonClass}
                            onClick={(event) => {
                              event.stopPropagation()
                              void navigator.clipboard.writeText(entry.uuid)
                            }}
                            title="Copy entry id"
                            type="reset"
                          >
                            <Clipboard aria-hidden="true" className="size-3.5" />
                          </button>
                          <button
                            aria-label={`${pinned ? 'Unpin' : 'Pin'} ${rowLabel(entry)}`}
                            className={cn(actionButtonClass, pinned && 'text-ink')}
                            disabled={metadataLoading || pinning.has(entry.uuid)}
                            onClick={(event) => {
                              event.stopPropagation()
                              void togglePinned(entry)
                            }}
                            title={pinned ? 'Unpin entry' : 'Pin entry'}
                            type="reset"
                          >
                            <Pin aria-hidden="true" className={cn('size-3.5', pinned && 'fill-current')} />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
            </TableBody>
            {visibleRows.length > 0 && (
              <TableFooter className="border-edge bg-panel">
                <TableRow className="h-[var(--row-h)] border-0 hover:bg-panel">
                  <TableCell
                    className="h-[var(--row-h)] px-2.5 py-[var(--cell-py)]"
                    colSpan={displayColumns.length + 2}
                  >
                    <div className="flex items-center justify-between">
                      <span className="num text-micro text-ink-3">
                        {visibleRows.length.toLocaleString()} loaded
                        {pinnedOnly ? ' pinned' : ''}
                      </span>
                      {hasMore && (
                        <Button
                          loading={loadingMore}
                          onClick={onLoadMore}
                          size="xs"
                          variant="ghost"
                        >
                          <ArrowDown aria-hidden="true" />
                          Older
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>

          {!loading && error && rows.length === 0 && (
            <Alert className="m-3 w-auto rounded-sm" variant="error">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>Entries could not be loaded</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
              <AlertAction>
                <Button onClick={onRetry} size="sm" variant="outline">
                  Try again
                </Button>
              </AlertAction>
            </Alert>
          )}

          {!loading && !error && visibleRows.length === 0 && (
            <Empty className="border-0 py-12 md:py-14">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  {pinnedOnly ? <Pin aria-hidden="true" /> : <Inbox aria-hidden="true" />}
                </EmptyMedia>
                <EmptyTitle className="text-md">
                  {pinnedOnly ? 'No pinned entries' : emptyTitle}
                </EmptyTitle>
                <EmptyDescription>
                  {pinnedOnly
                    ? 'Pin an entry from any row to keep important runtime evidence close at hand.'
                    : emptyDescription}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

        </div>
      </Panel>

      {error && rows.length > 0 && (
        <Alert className="rounded-sm" variant="error">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>More entries could not be loaded</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
          <AlertAction>
            <Button onClick={onRetry} size="xs" variant="ghost">
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}


      {selected.length === 2 && (
        <>
          <Button
            className="fixed bottom-4 left-1/2 z-[var(--z-overlay)] -translate-x-1/2 shadow-lg"
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
