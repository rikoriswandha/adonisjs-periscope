import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { CopyButton } from '@/components/copy-button'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

function primitiveValue(value: unknown) {
  if (value === null) return <span className="text-muted-foreground">null</span>
  if (typeof value === 'string') return <span className="text-info-foreground">“{value}”</span>
  if (typeof value === 'number') return <span className="text-primary">{value}</span>
  if (typeof value === 'boolean') {
    return <span className="text-warning-foreground">{String(value)}</span>
  }
  return <span className="text-muted-foreground">{String(value)}</span>
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const structured = typeof value === 'object' && value !== null
  const [open, setOpen] = useState(depth < 1)
  if (!structured) {
    return (
      <div className="flex min-h-6 items-start gap-2 py-0.5 font-mono text-xs leading-5">
        {name !== undefined && <span className="shrink-0 text-foreground">{name}:</span>}
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
      <div className="py-0.5 font-mono text-xs leading-5">
        {name !== undefined && <span>{name}: </span>}
        <span className="text-muted-foreground">{delimiters.join('')}</span>
      </div>
    )
  }

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="group flex min-h-6 w-full items-center gap-1 py-0.5 text-left font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        {name !== undefined && <span>{name}: </span>}
        <span className="text-muted-foreground">
          {delimiters[0]} {entries.length} {entries.length === 1 ? 'item' : 'items'} {delimiters[1]}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="ms-1.5 border-s ps-3">
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
    <section aria-label={label} className="overflow-hidden rounded-md border bg-muted/35">
      <div className="flex min-h-8 items-center justify-between border-b px-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <CopyButton label={`Copy ${label}`} value={serialized} />
      </div>
      <div className="max-h-96 overflow-auto p-3">
        <JsonNode depth={0} value={value} />
      </div>
    </section>
  )
}
