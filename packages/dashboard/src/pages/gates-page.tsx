import { ArrowUpRight } from 'lucide-react'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { GateContent, StoredEntry } from '@/types'

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

function GateDetail({ entry, onClose }: RegisteredEntryDetailProps) {
  const content = gateContent(entry)
  const argsCount = argumentCount(content.args)
  return (
    <EntryDetailDrawer
      description={`User ${content.userId ?? 'anonymous'} · ${formatDateTime(entry.createdAt)}`}
      meta={
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
      }
      onOpenChange={(open) => !open && onClose()}
      open
      tags={entry.tags}
      title={truncate(content.ability, 96)}
    >
      <dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Ability</dt>
          <dd className="mt-1 break-all font-mono text-sm">{content.ability}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">User ID</dt>
          <dd className="mt-1 break-all font-mono text-sm">{content.userId ?? 'Anonymous'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Decision message</dt>
          <dd className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-sm">
            {content.message ??
              (content.allowed ? 'The ability was authorized.' : 'No denial message was recorded.')}
          </dd>
        </div>
      </dl>
      <JsonTree label="Authorization arguments" value={content.args} />
      {content.user !== undefined && <JsonTree label="Serialized user" value={content.user} />}
    </EntryDetailDrawer>
  )
}

export const gatesEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Authorization gates',
  description:
    'Audit Bouncer ability checks with explicit decisions, users, arguments, and denial context.',
  caption: 'Recorded authorization gate decisions',
  columns,
  emptyTitle: (tag?: string) =>
    tag ? 'No matching gate decisions' : 'Waiting for an authorization check',
  emptyDescription: (tag?: string) =>
    tag
      ? `No authorization decision carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Authorize an ability through Bouncer while gate events are enabled. Decisions appear here automatically.',
  rowLabel: (entry: StoredEntry) => {
    const content = gateContent(entry)
    return `Inspect ${content.allowed ? 'allowed' : 'denied'} ability: ${content.ability}`
  },
  detailComponent: GateDetail,
}
