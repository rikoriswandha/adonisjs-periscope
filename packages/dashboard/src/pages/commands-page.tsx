import { ArrowUpRight } from 'lucide-react'

import { DurationBadge } from '@/components/duration-badge'
import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { Badge } from '@/components/ui/badge'
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

function CommandDetail({ entry, onClose }: RegisteredEntryDetailProps) {
  const content = commandContent(entry)
  return (
    <EntryDetailDrawer
      description={`${content.isMain ? 'Main process' : 'Nested command'} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <>
          <Badge variant={content.isMain ? 'info' : 'secondary'}>
            {content.isMain ? 'main process' : 'nested command'}
          </Badge>
          <Badge className="font-mono" variant={content.exitCode === 0 ? 'success' : 'destructive'}>
            exit {content.exitCode}
          </Badge>
          <DurationBadge value={content.durationMs} />
        </>
      }
      onOpenChange={(open) => !open && onClose()}
      open
      tags={entry.tags}
      title={truncate(content.command, 96)}
    >
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
