import { Badge } from '@/components/ui/badge'
import type { ExceptionCodeFrameLine, ExceptionStackFrame } from '@/types'

export function StackTrace({
  frames,
  codeFrame,
  fallback,
}: {
  frames: ExceptionStackFrame[]
  codeFrame?: ExceptionCodeFrameLine[]
  fallback?: string
}) {
  return (
    <div className="space-y-4">
      {codeFrame && codeFrame.length > 0 && (
        <section aria-label="Source code frame" className="overflow-hidden rounded-lg border bg-muted/35">
          <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
            Source context
          </div>
          <pre className="overflow-auto py-2 font-mono text-xs leading-5">
            {codeFrame.map((line) => (
              <code
                className={`grid grid-cols-[3.5rem_1fr] px-3 ${
                  line.highlight ? 'bg-warning/12 text-foreground' : 'text-muted-foreground'
                }`}
                key={line.line}
              >
                <span className="select-none pe-4 text-right tabular-nums">{line.line}</span>
                <span>{line.source || ' '}</span>
              </code>
            ))}
          </pre>
        </section>
      )}

      <section aria-label="Stack frames" className="overflow-hidden rounded-lg border">
        <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
          Stack trace
        </div>
        {frames.length > 0 ? (
          <ol className="divide-y">
            {frames.map((frame, index) => (
              <li
                className={`grid gap-1 px-3 py-2.5 font-mono text-xs sm:grid-cols-[minmax(10rem,0.45fr)_1fr] ${
                  frame.type === 'app' ? 'bg-accent/45' : 'bg-background'
                }`}
                key={`${frame.raw}-${index}`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Badge size="sm" variant={frame.type === 'app' ? 'info' : 'secondary'}>
                    {frame.type}
                  </Badge>
                  <span className="truncate text-foreground">{frame.function ?? '(anonymous)'}</span>
                </div>
                <span className="min-w-0 break-all text-muted-foreground">
                  {frame.file}
                  {frame.line !== null ? `:${frame.line}` : ''}
                  {frame.column !== null ? `:${frame.column}` : ''}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <pre className="overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-5 text-muted-foreground">
            {fallback || 'No parsed stack frames were recorded.'}
          </pre>
        )}
      </section>
    </div>
  )
}
