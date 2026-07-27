import { ArrowDown, CircleAlert, Inbox, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'

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
import type { StoredEntry } from '@/types'

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

  return (
    <div className="space-y-2">
      {newCount > 0 && onAcceptNew && (
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

      <Frame className="rounded-lg p-0.5">
        <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
          <div className="overflow-x-auto">
            <Table className="min-w-data-table text-xs">
              <TableCaption className="sr-only">{caption}</TableCaption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
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
                      {columns.map((column) => (
                        <TableCell className="px-2.5 py-2" key={column.key}>
                          <Skeleton className="h-3.5 w-full max-w-36" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}

                {!loading &&
                  rows.map((entry) => (
                    <TableRow
                      className="cursor-pointer"
                      key={entry.uuid}
                      onClick={() => onRowOpen(entry)}
                    >
                      {columns.map((column) => (
                        <TableCell className={`px-2.5 py-2 ${column.className ?? ''}`} key={column.key}>
                          {column.key === primaryColumnKey ? (
                            <button
                              className="block w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                              type="button"
                            >
                              <span className="sr-only">{rowLabel(entry)}: </span>
                              {column.cell(entry)}
                            </button>
                          ) : (
                            column.cell(entry)
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
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

          {!loading && !error && rows.length === 0 && (
            <Empty className="border-0 py-12 md:py-14">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Inbox aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle className="text-base">{emptyTitle}</EmptyTitle>
                <EmptyDescription>{emptyDescription}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {rows.length > 0 && (
            <div className="flex items-center justify-between border-t bg-muted/40 px-2.5 py-1.5">
              <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                {rows.length.toLocaleString()} loaded
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
        <div className="flex items-center justify-between rounded-md border bg-destructive/5 px-2.5 py-2 text-xs text-destructive-foreground">
          <span>{error.message}</span>
          <Button onClick={onRetry} size="xs" variant="ghost">
            Retry
          </Button>
        </div>
      )}
    </div>
  )
}
