import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import { format } from 'sql-formatter'

import { CopyButton } from '@/components/copy-button'
import { JsonTree } from '@/components/json-tree'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'

export function SqlBlock({ sql, bindings }: { sql: string; bindings?: unknown }) {
  const [bindingsOpen, setBindingsOpen] = useState(false)
  const formatted = useMemo(() => {
    try {
      return format(sql, { language: 'sql', keywordCase: 'upper' })
    } catch {
      return sql
    }
  }, [sql])

  return (
    <section aria-label="SQL query" className="overflow-hidden rounded-lg border bg-muted/35">
      <div className="flex min-h-9 items-center justify-between border-b px-3">
        <span className="text-xs font-medium text-muted-foreground">SQL</span>
        <CopyButton label="Copy SQL" value={formatted} />
      </div>
      <pre className="max-h-96 overflow-auto p-4 font-mono text-xs leading-5 text-foreground">
        <code>{formatted}</code>
      </pre>
      {bindings !== undefined && (
        <Collapsible onOpenChange={setBindingsOpen} open={bindingsOpen}>
          <CollapsibleTrigger className="flex w-full items-center justify-between border-t px-3 py-2 text-left text-xs font-medium outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring">
            <span>Bindings</span>
            <ChevronDown
              aria-hidden="true"
              className={`size-3.5 transition-transform ${bindingsOpen ? 'rotate-180' : ''}`}
            />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="border-t p-3">
              <JsonTree label="Query bindings" value={bindings} />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      )}
    </section>
  )
}
