import { ArrowUpRight, Route } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import { EntryIndexTable, type EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
import { useDashboard } from '@/dashboard-context'
import { useCursorPagination } from '@/hooks/use-cursor-pagination'
import { useNewEntryPolling } from '@/hooks/use-polling'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { EntryFilters, GateContent, StoredEntry } from '@/types'

function gateContent(entry: StoredEntry): GateContent {
  return entry.content as GateContent
}

function argumentCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length
  if (typeof value === 'object' && value !== null) return Object.keys(value).length
  return value === undefined ? null : 1
}

const columns: EntryColumn[] = [
  {
    key: 'ability',
    header: 'Ability',
    primary: true,
    cell: (entry) => {
      const content = gateContent(entry)
      const count = argumentCount(content.args)
      return (
        <div className="min-w-0">
          <div className="max-w-xl truncate font-mono text-xs font-medium" title={content.ability}>
            {truncate(content.ability, 120)}
          </div>
          <div className="mt-1 text-2xs text-muted-foreground">
            {count === null
              ? 'Arguments unavailable'
              : `${count} ${count === 1 ? 'argument' : 'arguments'}`}
          </div>
        </div>
      )
    },
  },
  {
    key: 'decision',
    header: 'Decision',
    className: 'w-24',
    cell: (entry) => {
      const allowed = gateContent(entry).allowed
      return (
        <Badge variant={allowed ? 'success' : 'destructive'}>
          {allowed ? 'allowed' : 'denied'}
        </Badge>
      )
    },
  },
  {
    key: 'user',
    header: 'User',
    className: 'w-36',
    cell: (entry) => (
      <span
        className="block max-w-36 truncate font-mono text-xs text-muted-foreground"
        title={String(gateContent(entry).userId ?? 'Anonymous')}
      >
        {gateContent(entry).userId ?? 'Anonymous'}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    className: 'w-24',
    cell: (entry) => {
      const status = gateContent(entry).status
      return (
        <Badge className="font-mono" variant="secondary">
          {status === undefined ? 'not set' : `HTTP ${status}`}
        </Badge>
      )
    },
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

export function GatesPage() {
  const [searchParams] = useSearchParams()
  const { status, revision } = useDashboard()
  const [selected, setSelected] = useState<StoredEntry | null>(null)
  const tag = searchParams.get('tag')?.trim() || undefined
  const filters = useMemo<EntryFilters>(
    () => ({ type: 'gate', tag, displayOnIndex: true, limit: 50 }),
    [tag]
  )
  const pagination = useCursorPagination(filters)
  const reload = pagination.reload
  const polling = useNewEntryPolling(pagination.entries, filters, status?.paused ?? true, revision)

  useEffect(() => {
    if (revision > 0) void reload()
  }, [reload, revision])

  const acceptNew = () => pagination.prepend(polling.accept())
  const content = selected ? gateContent(selected) : null
  const argsCount = content ? argumentCount(content.args) : null

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold tracking-tight">Authorization gates</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Audit Bouncer ability checks with explicit decisions, users, arguments, and denial
            context.
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
        caption="Recorded authorization gate decisions"
        columns={columns}
        emptyDescription={
          tag
            ? `No authorization decision carries the exact tag “${tag}”. Try another tag or clear the filter.`
            : 'Authorize an ability through Bouncer while gate events are enabled. Decisions appear here automatically.'
        }
        emptyTitle={tag ? 'No matching gate decisions' : 'Waiting for an authorization check'}
        error={pagination.error}
        hasMore={pagination.hasMore}
        loading={pagination.loading}
        loadingMore={pagination.loadingMore}
        newCount={polling.pending.length}
        onAcceptNew={acceptNew}
        onLoadMore={() => void pagination.loadMore()}
        onRetry={() => void pagination.reload()}
        onRowOpen={setSelected}
        rowLabel={(entry) => {
          const entryContent = gateContent(entry)
          return `Inspect ${entryContent.allowed ? 'allowed' : 'denied'} ability: ${entryContent.ability}`
        }}
        rows={pagination.entries}
      />

      <EntryDetailDrawer
        description={
          selected
            ? `User ${content?.userId ?? 'anonymous'} · ${formatDateTime(selected.createdAt)}`
            : 'Authorization detail'
        }
        meta={
          content && (
            <>
              <Badge variant={content.allowed ? 'success' : 'destructive'}>
                {content.allowed ? 'allowed' : 'denied'}
              </Badge>
              <Badge variant="secondary">
                {argsCount === null
                  ? 'arguments unavailable'
                  : `${argsCount} ${argsCount === 1 ? 'argument' : 'arguments'}`}
              </Badge>
              {content.status !== undefined && (
                <Badge className="font-mono" variant="secondary">
                  HTTP {content.status}
                </Badge>
              )}
            </>
          )
        }
        onOpenChange={(open) => !open && setSelected(null)}
        open={selected !== null}
        title={content ? truncate(content.ability, 96) : 'Authorization detail'}
      >
        {content && (
          <>
            <dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Ability</dt>
                <dd className="mt-1 break-all font-mono text-sm">{content.ability}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">User ID</dt>
                <dd className="mt-1 break-all font-mono text-sm">
                  {content.userId ?? 'Anonymous'}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Decision message</dt>
                <dd className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-sm">
                  {content.message ??
                    (content.allowed
                      ? 'The ability was authorized.'
                      : 'No denial message was recorded.')}
                </dd>
              </div>
            </dl>

            <JsonTree label="Authorization arguments" value={content.args} />
            {content.user !== undefined && (
              <JsonTree label="Serialized user" value={content.user} />
            )}
          </>
        )}
      </EntryDetailDrawer>
    </div>
  )
}
