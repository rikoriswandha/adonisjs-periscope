import { ShieldCheck } from 'lucide-react'

import { Well } from '@/components/instrument'
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
      <Well aria-label={title} className="min-w-0 max-w-full overflow-hidden" role="region">
        <header className="flex min-h-9 items-center justify-between gap-2 border-b border-edge px-3">
          <h3 className="micro-label truncate text-ink-2">Rendered message</h3>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-3">
            <ShieldCheck aria-hidden="true" className="size-3.5 text-sig-ok" />
            HTML sanitized
          </span>
        </header>
        <iframe
          className="h-96 w-full border-0 bg-well"
          referrerPolicy="no-referrer"
          sandbox=""
          srcDoc={sanitizeMailPreviewHtml(html)}
          title={title}
        />
      </Well>
    )
  }

  if (text?.trim()) {
    return (
      <Well aria-label={title} className="min-w-0 max-w-full overflow-hidden" role="region">
        <header className="flex min-h-9 items-center border-b border-edge px-3">
          <h3 className="micro-label text-ink-2">Plain-text message</h3>
        </header>
        <pre className="num max-h-96 overflow-auto whitespace-pre-wrap break-words p-3 text-sm leading-6 text-ink-2">
          {text}
        </pre>
      </Well>
    )
  }
  return (
    <p className="well num min-w-0 max-w-full break-words p-3 text-sm leading-6 text-ink-3">
      No HTML or plain-text body was captured for this message.
    </p>
  )
}
