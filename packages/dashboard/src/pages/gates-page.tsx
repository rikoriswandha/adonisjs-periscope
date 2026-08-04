import { ArrowUpRight } from 'lucide-react'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { StatusDot } from '@/components/instrument'
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
          <div className="num max-w-xl truncate text-xs font-medium" title={content.ability}>
            {truncate(content.ability, 120)}
          </div>
          <div className="num mt-1 text-2xs text-ink-3">
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
        <span className="num inline-flex items-center gap-2 text-xs">
          <StatusDot signal={allowed ? 'ok' : 'error'} />
          {allowed ? 'allowed' : 'denied'}
        </span>
      )
    },
  },
  {
    key: 'user',
    header: 'User',
    className: 'w-36',
    cell: (entry) => (
      <span
        className="num block max-w-36 truncate text-xs text-ink-3"
        title={String(gateContent(entry).userId ?? 'Anonymous')}
      >
        {gateContent(entry).userId ?? 'Anonymous'}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    className: 'w-24 text-right',
    cell: (entry) => {
      const status = gateContent(entry).status
      return (
        <span className="num block whitespace-nowrap text-right text-xs text-ink-2">
          {status === undefined ? 'not set' : `HTTP ${status}`}
        </span>
      )
    },
  },
  {
    key: 'when',
    header: 'When',
    className: 'w-36 text-right',
    cell: (entry) => (
      <span className="num block whitespace-nowrap text-right text-xs text-ink-3" title={entry.createdAt}>
        {formatRelativeTime(entry.createdAt)}
      </span>
    ),
  },
  {
    key: 'open',
    header: '',
    className: 'w-10 text-right',
    cell: () => (
      <ArrowUpRight aria-hidden="true" className="ms-auto size-4 text-ink-3" />
    ),
  },
]

function GateDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = gateContent(entry)
  const argsCount = argumentCount(content.args)
  return (
    <EntryDetailDrawer
      description={`User ${content.userId ?? 'anonymous'} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <span className="flex flex-wrap items-center gap-3">
          <span className="num inline-flex items-center gap-2 text-xs">
            <StatusDot signal={content.allowed ? 'ok' : 'error'} />
            {content.allowed ? 'allowed' : 'denied'}
          </span>
          <span className="num text-xs text-ink-2">
            {argsCount === null
              ? 'arguments unavailable'
              : `${argsCount} ${argsCount === 1 ? 'argument' : 'arguments'}`}
          </span>
          {content.status !== undefined && (
            <span className="num text-xs text-ink-2">HTTP {content.status}</span>
          )}
        </span>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(content.ability, 96)}
    >
      <dl className="well grid gap-2.5 p-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Ability</dt>
          <dd className="num mt-0.5 break-all text-sm">{content.ability}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">User ID</dt>
          <dd className="num mt-0.5 break-all text-sm">{content.userId ?? 'Anonymous'}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-ink-3">Decision message</dt>
          <dd className="num mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-words text-sm">
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
