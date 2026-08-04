import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { CopyButton } from '@/components/copy-button'
import { Well } from '@/components/instrument'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

function primitiveValue(value: unknown) {
  if (value === null) return <span className="text-sig-warn">null</span>
  if (typeof value === 'string') return <span className="text-sig-ok">“{value}”</span>
  if (typeof value === 'number') return <span className="text-sig-info">{value}</span>
  if (typeof value === 'boolean') return <span className="text-sig-warn">{String(value)}</span>
  return <span className="text-ink-3">{String(value)}</span>
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const structured = typeof value === 'object' && value !== null
  const [open, setOpen] = useState(depth < 1)

  if (!structured) {
    return (
      <div className="num flex min-h-6 items-start gap-1.5 py-0.5 text-xs leading-5">
        {name !== undefined && (
          <>
            <span className="break-all text-ink-2">{name}</span>
            <span aria-hidden="true" className="text-ink-4">:</span>
          </>
        )}
        <span className="min-w-0 break-all">{primitiveValue(value)}</span>
      </div>
    )
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value)
  const delimiters = Array.isArray(value) ? ['[', ']'] : ['{', '}']

  if (entries.length === 0) {
    return (
      <div className="num py-0.5 text-xs leading-5">
        {name !== undefined && (
          <>
            <span className="text-ink-2">{name}</span>
            <span className="text-ink-4">: </span>
          </>
        )}
        <span className="text-ink-4">{delimiters.join('')}</span>
      </div>
    )
  }

  const itemLabel = `${entries.length} ${entries.length === 1 ? 'item' : 'items'}`

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="group num flex min-h-6 w-full items-center gap-1 py-0.5 text-left text-xs leading-5 text-ink-2 outline-none transition-colors hover:text-ink focus-visible:bg-panel-raised active:bg-panel-raised disabled:pointer-events-none disabled:opacity-50">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-ink-3 transition-transform duration-(--dur-fast)',
            open && 'rotate-90'
          )}
        />
        {name !== undefined && (
          <>
            <span className="break-all">{name}</span>
            <span aria-hidden="true" className="text-ink-4">:</span>
          </>
        )}
        <span className="text-ink-4">
          {delimiters[0]} {itemLabel} {delimiters[1]}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="ms-[7px] border-s border-edge ps-3">
          {entries.map(([key, item]) => (
            <JsonNode depth={depth + 1} key={key} name={key} value={item} />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  )
}

export function JsonTree({ value, label = 'JSON data' }: { value: unknown; label?: string }) {
  let serialized: string
  try {
    serialized = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    serialized = String(value)
  }

  return (
    <Well aria-label={label} className="overflow-hidden" role="region">
      <header className="flex min-h-9 items-center justify-between gap-2 border-b border-edge px-3">
        <h3 className="micro-label truncate text-ink-2">{label}</h3>
        <CopyButton label={`Copy ${label}`} value={serialized} />
      </header>
      <div className="num max-h-96 overflow-auto p-3">
        <JsonNode depth={0} value={value} />
      </div>
    </Well>
  )
}
