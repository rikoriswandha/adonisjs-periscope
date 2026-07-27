import { ArrowUpRight, Download } from 'lucide-react'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { MailPreview } from '@/components/mail-preview'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import type { EntryTypeImplementation, RegisteredEntryDetailProps } from '@/entry-type-registry'
import { api } from '@/lib/api'
import { formatDateTime, formatRelativeTime, truncate } from '@/lib/format'
import type { MailContent, StoredEntry } from '@/types'

function mailContent(entry: StoredEntry): MailContent {
  return entry.content as MailContent
}

function mailSubject(content: MailContent): string {
  return content.subject?.trim() || 'Untitled message'
}

function eventLabel(event: MailContent['event']): string {
  return event.replace(/_/g, ' ')
}

function eventVariant(
  event: MailContent['event']
): 'secondary' | 'info' | 'success' | 'destructive' {
  switch (event) {
    case 'sending':
    case 'queueing':
      return 'info'
    case 'sent':
    case 'queued':
      return 'success'
    case 'queue_error':
      return 'destructive'
    default:
      return 'secondary'
  }
}

function PlainTextBody({ text }: { text?: string }) {
  if (!text?.trim()) {
    return (
      <p className="rounded-md border bg-muted/25 p-3 text-sm leading-6 text-muted-foreground">
        No plain-text body was captured for this message.
      </p>
    )
  }
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/25 p-3 font-sans text-sm leading-6 text-foreground">
      {text}
    </pre>
  )
}

const columns: EntryColumn[] = [
  {
    key: 'subject',
    header: 'Subject',
    primary: true,
    cell: (entry) => {
      const content = mailContent(entry)
      const subject = mailSubject(content)
      return (
        <div className="min-w-0">
          <div className="max-w-xl truncate text-sm font-medium" title={subject}>
            {truncate(subject, 120)}
          </div>
          <div className="mt-1 max-w-xl truncate font-mono text-xs text-muted-foreground">
            {content.messageId ?? 'Message ID unavailable'}
          </div>
        </div>
      )
    },
  },
  {
    key: 'event',
    header: 'Event',
    className: 'w-28',
    cell: (entry) => {
      const event = mailContent(entry).event
      return <Badge variant={eventVariant(event)}>{eventLabel(event)}</Badge>
    },
  },
  {
    key: 'mailer',
    header: 'Mailer',
    className: 'w-36',
    cell: (entry) => (
      <span className="font-mono text-xs text-muted-foreground">{mailContent(entry).mailer}</span>
    ),
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

function MailDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = mailContent(entry)
  const hasRaw = typeof content.raw === 'string' && content.raw.length > 0
  return (
    <EntryDetailDrawer
      description={`${content.mailer} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <>
          <Badge variant={eventVariant(content.event)}>{eventLabel(content.event)}</Badge>
          {content.truncated && <Badge variant="warning">truncated</Badge>}
        </>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={mailSubject(content)}
    >
      <dl className="grid gap-2.5 rounded-md border p-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Mailer</dt>
          <dd className="mt-0.5 font-mono text-sm">{content.mailer}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Lifecycle event</dt>
          <dd className="mt-0.5 text-sm">{eventLabel(content.event)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Message ID</dt>
          <dd className="mt-0.5 break-all font-mono text-xs">{content.messageId ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Capture state</dt>
          <dd className="mt-0.5 text-sm">
            {content.truncated ? 'Truncated at the configured limit' : 'Not truncated'}
          </dd>
        </div>
      </dl>
      {hasRaw && (
        <div className="flex justify-end">
          <Button render={<a download href={api.getEntryEmlUrl(entry.uuid)} />} variant="outline">
            <Download aria-hidden="true" />
            Download EML
          </Button>
        </div>
      )}
      <Tabs defaultValue="preview">
        <div className="border-b">
          <TabsList variant="underline">
            <TabsTab value="preview">Preview</TabsTab>
            <TabsTab value="text">Text</TabsTab>
            <TabsTab value="envelope">Envelope</TabsTab>
          </TabsList>
        </div>
        <TabsPanel value="preview">
          <MailPreview
            html={content.html}
            text={content.text}
            title={`Preview of ${mailSubject(content)}`}
          />
        </TabsPanel>
        <TabsPanel value="text">
          <PlainTextBody text={content.text} />
        </TabsPanel>
        <TabsPanel value="envelope">
          <div className="space-y-3">
            <JsonTree label="Envelope" value={content.envelope ?? {}} />
            <JsonTree label="Metadata" value={content.metadata ?? {}} />
          </div>
        </TabsPanel>
      </Tabs>
      {content.response !== undefined && (
        <JsonTree label="Transport response" value={content.response} />
      )}
      {content.error !== undefined && <JsonTree label="Mail error" value={content.error} />}
    </EntryDetailDrawer>
  )
}

export const mailEntryTypeImplementation: EntryTypeImplementation = {
  heading: 'Mail activity',
  description:
    'Inspect delivery lifecycle events, rendered bodies, envelopes, and transport metadata.',
  caption: 'Recorded mail activity',
  columns,
  emptyTitle: (tag?: string) => (tag ? 'No matching mail activity' : 'Waiting for mail activity'),
  emptyDescription: (tag?: string) =>
    tag
      ? `No mail entry carries the exact tag “${tag}”. Try another tag or clear the filter.`
      : 'Send or queue a message while mail events are enabled. It will appear here automatically.',
  rowLabel: (entry: StoredEntry) =>
    `Inspect mail: ${truncate(mailSubject(mailContent(entry)), 80)}`,
  detailComponent: MailDetail,
}
