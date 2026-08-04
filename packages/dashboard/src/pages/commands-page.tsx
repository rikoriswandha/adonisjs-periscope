import { ArrowUpRight } from 'lucide-react'

import { DurationBadge } from '@/components/duration-badge'
import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { StatusDot } from '@/components/instrument'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { CommandContent, StoredEntry } from '@/types'

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
          <div className="num max-w-xl truncate text-xs font-medium" title={content.command}>
            {truncate(content.command, 120)}
          </div>
          <div
            className="num mt-1 max-w-xl truncate text-2xs text-ink-3"
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
      <span className="num inline-flex items-center gap-2 text-xs">
        <StatusDot signal="neutral" />
        {commandContent(entry).isMain ? 'main process' : 'nested command'}
      </span>
    ),
  },
  {
    key: 'result',
    header: 'Result',
    className: 'w-24 text-right',
    cell: (entry) => {
      const exitCode = commandContent(entry).exitCode
      return (
        <span className="num inline-flex items-center justify-end gap-2 text-xs">
          <StatusDot signal={exitCode === 0 ? 'ok' : 'error'} />
          exit {exitCode}
        </span>
      )
    },
  },
  {
    key: 'duration',
    header: 'Duration',
    className: 'w-28 text-right',
    cell: (entry) => <DurationBadge value={commandContent(entry).durationMs} />,
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

function CommandDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = commandContent(entry)
  return (
    <EntryDetailDrawer
      description={`${content.isMain ? 'Main process' : 'Nested command'} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <span className="flex flex-wrap items-center gap-3">
          <span className="num inline-flex items-center gap-2 text-xs">
            <StatusDot signal="neutral" />
            {content.isMain ? 'main process' : 'nested command'}
          </span>
          <span className="num inline-flex items-center gap-2 text-xs">
            <StatusDot signal={content.exitCode === 0 ? 'ok' : 'error'} />
            exit {content.exitCode}
          </span>
          <DurationBadge value={content.durationMs} />
        </span>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={truncate(content.command, 96)}
    >
      <section className="well overflow-hidden">
        <div className="micro-label border-b border-edge px-3 py-2">Invocation</div>
        <pre className="num max-h-40 overflow-auto whitespace-pre-wrap break-words p-3 text-xs leading-5">
          {content.command}
        </pre>
      </section>
      <div className="grid gap-3 sm:grid-cols-2">
        <JsonTree label="Arguments" value={content.args} />
        <JsonTree label="Flags" value={content.flags} />
      </div>
      {content.output !== undefined && (
        <section className="well overflow-hidden">
          <div className="micro-label border-b border-edge px-3 py-2">Command output</div>
          <pre className="num max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 text-xs leading-5">
            {content.output || 'The command completed without writing output.'}
          </pre>
        </section>
      )}
      {content.error !== undefined && <JsonTree label="Command error" value={content.error} />}
    </EntryDetailDrawer>
  )
}

export const commandsEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Ace commands',
  description:
    'Inspect command arguments, flags, process role, output, failures, and execution time.',
  caption: 'Recorded Ace command executions',
  columns,
  emptyTitle: (tag?: string) => (tag ? 'No matching commands' : 'Waiting for a command'),
  emptyDescription: (tag?: string) =>
    tag
      ? `No command carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Run an Ace command while command events are enabled. Completed executions appear here automatically.',
  rowLabel: (entry: StoredEntry) =>
    `Inspect command: ${truncate(commandContent(entry).command, 80)}`,
  detailComponent: CommandDetail,
}
