import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import { format } from 'sql-formatter'

import { CopyButton } from '@/components/copy-button'
import { Well } from '@/components/instrument'
import { JsonTree } from '@/components/json-tree'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { tokenizeSql } from '@/components/sql-tokenizer'
import type { SqlTokenKind } from '@/components/sql-tokenizer'
import { cn } from '@/lib/utils'
const TOKEN_CLASS_BY_KIND: Partial<Record<SqlTokenKind, string>> = {
  plain: 'text-ink-2',
  keyword: 'font-semibold text-sig-info',
  string: 'text-sig-ok',
  number: 'text-sig-warn',
  comment: 'italic text-ink-4',
}

export function SqlBlock({ sql, bindings }: { sql: string; bindings?: unknown }) {
  const [bindingsOpen, setBindingsOpen] = useState(false)
  const formatted = useMemo(() => {
    try {
      return format(sql, { language: 'sql', keywordCase: 'upper' })
    } catch {
      return sql
    }
  }, [sql])
  const tokens = useMemo(() => tokenizeSql(formatted), [formatted])

  return (
    <Well aria-label="SQL query" className="min-w-0 max-w-full overflow-hidden" role="region">
      <header className="flex min-h-9 items-center justify-between border-b border-edge px-3">
        <h3 className="micro-label text-ink-2">SQL</h3>
        <CopyButton label="Copy SQL" value={formatted} />
      </header>
      <pre className="num max-h-96 overflow-auto p-3 text-xs leading-5 text-ink">
        <code>
          {tokens.map((token, index) => (
            <span className={TOKEN_CLASS_BY_KIND[token.kind]} key={`${index}:${token.kind}`}>
              {token.value}
            </span>
          ))}
        </code>
      </pre>
      {bindings !== undefined && (
        <Collapsible onOpenChange={setBindingsOpen} open={bindingsOpen}>
          <CollapsibleTrigger className="flex min-h-(--control-h) w-full items-center justify-between border-t border-edge px-3 text-left text-xs font-medium text-ink-2 outline-none transition-colors pointer-coarse:min-h-11 hover:bg-panel-raised focus-visible:bg-panel-raised active:bg-panel-raised disabled:pointer-events-none disabled:opacity-50">
            <span>Bindings</span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-3.5 text-ink-3 transition-transform duration-(--dur-fast)',
                bindingsOpen && 'rotate-180'
              )}
            />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="border-t border-edge p-3">
              <JsonTree label="Query bindings" value={bindings} />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      )}
    </Well>
  )
}
