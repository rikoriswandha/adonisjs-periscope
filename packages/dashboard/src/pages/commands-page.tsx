import { ArrowUpRight, Route } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { DurationBadge } from '@/components/duration-badge'
import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import { EntryIndexTable, type EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
import { useDashboard } from '@/dashboard-context'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { CommandContent, EntryFilters, StoredEntry } from '@/types'

function commandContent(entry: StoredEntry): CommandContent {
  return entry.content as CommandContent
}

function summarize(value: unknown): string {
  if (value === undefined) return 'None'
  try {
    return truncate(JSON.stringify(value) ?? String(value), 96)
  } catch {
    return truncate(String(value), 96)
  }
}

const columns: EntryColumn[] = [
  {
    key: 'command',
    header: 'Command',
    primary: true,
    cell: (entry) => {
      const content = commandContent(entry)
      return (
        <div className="min-w-0">
          <div className="max-w-xl truncate font-mono text-xs font-medium" title={content.command}>
            {truncate(content.command, 120)}
          </div>
          <div
            className="mt-1 max-w-xl truncate font-mono text-2xs text-muted-foreground"
            title={summarize(content.args)}
          >
            args {summarize(content.args)}
          </div>
        </div>
      )
    },
  },
  {
    key: 'process',
    header: 'Process',
    className: 'w-32',
    cell: (entry) => (
      <Badge size="sm" variant={commandContent(entry).isMain ? 'info' : 'secondary'}>
        {commandContent(entry).isMain ? 'main process' : 'nested command'}
      </Badge>
    ),
  },
  {
    key: 'result',
    header: 'Result',
    className: 'w-24',
    cell: (entry) => {
      const exitCode = commandContent(entry).exitCode
      return (
        <Badge className="font-mono" variant={exitCode === 0 ? 'success' : 'destructive'}>
          exit {exitCode}
        </Badge>
      )
    },
  },
  {
    key: 'duration',
    header: 'Duration',
    className: 'w-28',
    cell: (entry) => <DurationBadge value={commandContent(entry).durationMs} />,
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36',
    cell: (entry) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground" title={entry.createdAt}>
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
  {
    key: 'open',
    header: '',
    className: 'w-10 text-right',
    cell: () => (
      <ArrowUpRight aria-hidden="true" className="ms-auto size-4 text-muted-foreground" />
    ),
  },
]

export function CommandsPage() {
  const [searchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const [selected, setSelected] = useState<StoredEntry | null>(null)
  const tag = searchParams.get('tag')?.trim() || undefined
  const filters = useMemo<EntryFilters>(
    () => ({ type: 'command', tag, displayOnIndex: true, limit: 50 }),
    [tag]
  )
  const pagination = useCursorPagination(filters)
  const reload = pagination.reload
  const polling = useNewEntryPolling(pagination.entries, filters, status?.paused ?? true, revision)

  useEffect(() => {
    if (revision > 0) void reload()
  }, [reload, revision])

  const acceptNew = () => pagination.prepend(polling.accept())
  const content = selected ? commandContent(selected) : null

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold tracking-tight">Ace commands</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Inspect command arguments, flags, process role, output, failures, and execution time.
          </p>
        </div>
        {tag && (
          <Badge variant="info">
            <Route aria-hidden="true" />
            tag:{tag}
          </Badge>
        )}
      </section>

      <EntryIndexTable
        caption="Recorded Ace command executions"
        columns={columns}
        emptyDescription={
          tag
            ? `No command carries the exact tag “${tag}”. Try another tag or clear the filter.`
            : 'Run an Ace command while command events are enabled. Completed executions appear here automatically.'
        }
        emptyTitle={tag ? 'No matching commands' : 'Waiting for a command'}
        error={pagination.error}
        hasMore={pagination.hasMore}
        loading={pagination.loading}
        loadingMore={pagination.loadingMore}
        newCount={polling.pending.length}
        onAcceptNew={acceptNew}
        onLoadMore={() => void pagination.loadMore()}
        onRetry={() => void pagination.reload()}
        onRowOpen={setSelected}
        rowLabel={(entry) => `Inspect command: ${truncate(commandContent(entry).command, 80)}`}
        rows={pagination.entries}
      />

      <EntryDetailDrawer
        description={
          selected
            ? `${content?.isMain ? 'Main process' : 'Nested command'} · ${formatDateTime(selected.createdAt)}`
            : 'Command detail'
        }
        meta={
          content && (
            <>
              <Badge variant={content.isMain ? 'info' : 'secondary'}>
                {content.isMain ? 'main process' : 'nested command'}
              </Badge>
              <Badge
                className="font-mono"
                variant={content.exitCode === 0 ? 'success' : 'destructive'}
              >
                exit {content.exitCode}
              </Badge>
              <DurationBadge value={content.durationMs} />
            </>
          )
        }
        onOpenChange={(open) => !open && setSelected(null)}
        open={selected !== null}
        title={content ? truncate(content.command, 96) : 'Command detail'}
      >
        {content && (
          <>
            <section className="overflow-hidden rounded-lg border bg-muted/35">
              <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                Invocation
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
                {content.command}
              </pre>
            </section>

            <div className="grid gap-4 sm:grid-cols-2">
              <JsonTree label="Arguments" value={content.args} />
              <JsonTree label="Flags" value={content.flags} />
            </div>

            {content.output !== undefined && (
              <section className="overflow-hidden rounded-lg border bg-muted/35">
                <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                  Command output
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
                  {content.output || 'The command completed without writing output.'}
                </pre>
              </section>
            )}

            {content.error !== undefined && (
              <JsonTree label="Command error" value={content.error} />
            )}
          </>
        )}
      </EntryDetailDrawer>
    </div>
  )
}
