import { ArrowUpRight, Download } from 'lucide-react'

import { EntryDetailDrawer } from '@/components/entry-detail-drawer'
import type { EntryColumn } from '@/components/entry-index-table'
import { JsonTree } from '@/components/json-tree'
import { MailPreview } from '@/components/mail-preview'
import { StatusDot, type Signal } from '@/components/instrument'
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

function eventSignal(event: MailContent['event']): Signal {
  switch (event) {
    case 'sending':
    case 'queueing':
      return 'info'
    case 'sent':
    case 'queued':
      return 'ok'
    case 'queue_error':
      return 'error'
  }
}

function Lifecycle({ event }: { event: MailContent['event'] }) {
  return (
    <span className="num inline-flex items-center gap-2 text-xs">
      <StatusDot signal={eventSignal(event)} />
      {eventLabel(event)}
    </span>
  )
}

function PlainTextBody({ text }: { text?: string }) {
  if (!text?.trim()) {
    return (
      <p className="well p-3 text-sm leading-6 text-ink-2">
        No plain-text body was captured for this message.
      </p>
    )
  }
  return (
    <pre className="num well max-h-96 overflow-auto whitespace-pre-wrap break-words p-3 text-sm leading-6 text-ink">
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
          <div className="num max-w-xl truncate text-sm font-medium" title={subject}>
            {truncate(subject, 120)}
          </div>
          <div
            className="num mt-1 max-w-xl truncate text-xs text-ink-3"
            title={content.messageId ?? 'Message ID unavailable'}
          >
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
    cell: (entry) => <Lifecycle event={mailContent(entry).event} />,
  },
  {
    key: 'mailer',
    header: 'Mailer',
    className: 'w-36',
    cell: (entry) => (
      <span className="num block max-w-36 truncate text-xs text-ink-3" title={mailContent(entry).mailer}>
        {mailContent(entry).mailer}
      </span>
    ),
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

function MailDetail({ entry, open, onClose }: RegisteredEntryDetailProps) {
  const content = mailContent(entry)
  const hasRaw = typeof content.raw === 'string' && content.raw.length > 0
  return (
    <EntryDetailDrawer
      description={`${content.mailer} · ${formatDateTime(entry.createdAt)}`}
      meta={
        <span className="flex flex-wrap items-center gap-3">
          <Lifecycle event={content.event} />
          {content.truncated && (
            <span className="num inline-flex items-center gap-2 text-xs">
              <StatusDot signal="warn" />
              truncated
            </span>
          )}
        </span>
      }
      onOpenChange={(open) => !open && onClose()}
      open={open}
      tags={entry.tags}
      title={mailSubject(content)}
    >
      <dl className="well grid gap-2.5 p-3 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Mailer</dt>
          <dd className="num mt-0.5 truncate text-sm" title={content.mailer}>
            {content.mailer}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Lifecycle event</dt>
          <dd className="mt-0.5">
            <Lifecycle event={content.event} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-3">Message ID</dt>
          <dd className="num mt-0.5 truncate text-xs" title={content.messageId ?? 'Unavailable'}>
            {content.messageId ?? 'Unavailable'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Capture state</dt>
          <dd className="mt-0.5">
            <span className="num inline-flex items-center gap-2 text-xs">
              <StatusDot signal={content.truncated ? 'warn' : 'neutral'} />
              {content.truncated ? 'Truncated at the configured limit' : 'Not truncated'}
            </span>
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
