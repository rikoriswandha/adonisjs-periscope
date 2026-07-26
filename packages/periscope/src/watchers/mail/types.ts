/*
 * periscope
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/** Lifecycle names stored by Periscope for the five events emitted by @adonisjs/mail 10. */
export type MailLifecycle = 'sending' | 'sent' | 'queueing' | 'queued' | 'queue_error'

/**
 * Content recorded for one mail lifecycle event. Structured application-owned values have already
 * crossed the shared safe serializer before reaching the recorder. Rendered bodies and raw MIME
 * source are independently limited to 256 KiB. Buffer-backed MIME is stored as base64 so bytes
 * outside UTF-8 survive recording; raw strings retain their legacy representation.
 */
export type MailEntryContent = {
  event: MailLifecycle
  mailer: string
  envelope?: unknown
  subject?: string
  html?: string
  text?: string
  raw?: string
  rawEncoding?: 'base64'
  messageId?: string
  metadata?: unknown
  response?: unknown
  error?: unknown
  truncated?: boolean
}

/**
 * Local structural descriptions of @adonisjs/mail 10 events. Keeping them here avoids a runtime
 * import of an integration that is optional for Periscope applications.
 */
export interface MailMessageEventPayload {
  mailerName: string
  message: unknown
  views: unknown
}

export interface MailSentEventPayload extends MailMessageEventPayload {
  response: unknown
}

export interface MailQueuedEventPayload extends MailMessageEventPayload {
  metaData?: unknown
}

export interface QueuedMailErrorEventPayload {
  error: unknown
  metaData?: unknown
  mailerName: string
}

export interface MailEventMap {
  'mail:sending': MailMessageEventPayload
  'mail:sent': MailSentEventPayload
  'mail:queueing': MailMessageEventPayload
  'mail:queued': MailQueuedEventPayload
  'queued:mail:error': QueuedMailErrorEventPayload
}
