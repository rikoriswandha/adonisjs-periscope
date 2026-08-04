import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { Well } from '@/components/instrument'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { ExceptionCodeFrameLine, ExceptionStackFrame } from '@/types'

function FrameRow({ frame, index }: { frame: ExceptionStackFrame; index: number }) {
  const isApp = frame.type === 'app'
  return (
    <li
      className={cn(
        'num grid min-h-(--row-h) gap-1 border-t border-edge px-3 py-(--cell-py) text-xs first:border-t-0 min-[640px]:grid-cols-[minmax(10rem,0.45fr)_1fr]',
        isApp ? 'bg-panel/35 text-ink-2' : 'text-ink-4'
      )}
      key={`${frame.raw}-${index}`}
    >
      <span className={cn('min-w-0 break-all', isApp && 'font-medium text-ink')}>
        {frame.function ?? '(anonymous)'}
      </span>
      <span className="min-w-0 break-all">
        {frame.file}
        {frame.line !== null ? `:${frame.line}` : ''}
        {frame.column !== null ? `:${frame.column}` : ''}
      </span>
    </li>
  )
}

export function StackTrace({
  frames,
  codeFrame,
  fallback,
}: {
  frames: ExceptionStackFrame[]
  codeFrame?: ExceptionCodeFrameLine[]
  fallback?: string
}) {
  const [vendorOpen, setVendorOpen] = useState(false)
  const appFrames = frames.filter((frame) => frame.type === 'app')
  const vendorFrames = frames.filter((frame) => frame.type !== 'app')

  return (
    <div className="min-w-0 max-w-full space-y-3">
      {codeFrame && codeFrame.length > 0 && (
        <Well aria-label="Source code frame" className="min-w-0 max-w-full overflow-hidden" role="region">
          <header className="flex min-h-9 items-center border-b border-edge px-3">
            <h3 className="micro-label text-ink-2">Source context</h3>
          </header>
          <pre className="num overflow-auto py-2 text-xs leading-5">
            {codeFrame.map((line) => (
              <code
                className={cn(
                  'grid min-w-max grid-cols-[3.5rem_minmax(0,1fr)] px-3 text-ink-3',
                  line.highlight && 'bg-sig-error/10 text-ink'
                )}
                key={line.line}
              >
                <span
                  className={cn(
                    'num select-none pe-4 text-right text-ink-4',
                    line.highlight && 'text-sig-error'
                  )}
                >
                  {line.line}
                </span>
                <span>{line.source || ' '}</span>
              </code>
            ))}
          </pre>
        </Well>
      )}

      <Well aria-label="Stack frames" className="min-w-0 max-w-full overflow-hidden" role="region">
        <header className="flex min-h-9 items-center justify-between border-b border-edge px-3">
          <h3 className="micro-label text-ink-2">Stack trace</h3>
          {frames.length > 0 && <span className="num text-micro text-ink-4">{frames.length} frames</span>}
        </header>
        {frames.length > 0 ? (
          <div>
            {appFrames.length > 0 && (
              <section aria-label="Application frames">
                <div className="flex min-h-8 items-center justify-between border-b border-edge px-3">
                  <h4 className="text-xs font-medium text-ink-2">Application</h4>
                  <span className="num text-micro text-ink-4">{appFrames.length}</span>
                </div>
                <ol>
                  {appFrames.map((frame, index) => (
                    <FrameRow frame={frame} index={index} key={`${frame.raw}-${index}`} />
                  ))}
                </ol>
              </section>
            )}

            {vendorFrames.length > 0 && (
              <Collapsible onOpenChange={setVendorOpen} open={vendorOpen}>
                <CollapsibleTrigger className="flex min-h-(--control-h) w-full items-center gap-2 border-t border-edge px-3 text-left text-xs text-ink-3 outline-none transition-colors pointer-coarse:min-h-11 first:border-t-0 hover:bg-panel-raised hover:text-ink-2 focus-visible:bg-panel-raised active:bg-panel-raised disabled:pointer-events-none disabled:opacity-50">
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      'size-3.5 transition-transform duration-(--dur-fast)',
                      vendorOpen && 'rotate-90'
                    )}
                  />
                  <span>Vendor frames</span>
                  <span className="num ms-auto text-micro text-ink-4">{vendorFrames.length}</span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <ol className="border-t border-edge">
                    {vendorFrames.map((frame, index) => (
                      <FrameRow frame={frame} index={index} key={`${frame.raw}-${index}`} />
                    ))}
                  </ol>
                </CollapsiblePanel>
              </Collapsible>
            )}
          </div>
        ) : (
          <pre className="num overflow-auto whitespace-pre-wrap p-3 text-xs leading-5 text-ink-3">
            {fallback || 'No parsed stack frames were recorded.'}
          </pre>
        )}
      </Well>
    </div>
  )
}
