import { sanitizeMailPreviewHtml } from '@/components/mail-preview-sanitizer'

export function MailPreview({
  html,
  text,
  title = 'Mail message preview',
}: {
  html?: string
  text?: string
  title?: string
}) {
  if (html?.trim()) {
    return (
      <iframe
        className="h-96 w-full rounded-lg border bg-background"
        referrerPolicy="no-referrer"
        sandbox=""
        srcDoc={sanitizeMailPreviewHtml(html)}
        title={title}
      />
    )
  }

  if (text?.trim()) {
    return (
      <section aria-label={title} className="overflow-hidden rounded-lg border bg-muted/25">
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-4 font-sans text-sm leading-6 text-foreground">
          {text}
        </pre>
      </section>
    )
  }

  return (
    <p className="rounded-lg border bg-muted/25 p-4 text-sm leading-6 text-muted-foreground">
      No HTML or plain-text body was captured for this message.
    </p>
  )
}
