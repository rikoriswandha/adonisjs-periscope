'use client'

import type { ReactNode } from 'react'
import { intFmt } from '../chart-formatters'

export interface TooltipRow {
  color: string
  label: string
  value: string | number
}

export interface TooltipContentProps {
  title?: string
  rows: TooltipRow[]
  /** Optional additional content (e.g., markers) */
  children?: ReactNode
}

export function TooltipContent({ title, rows, children }: TooltipContentProps) {
  return (
    <div className="overflow-hidden">
      <div className="px-3 py-2.5">
        {title && (
          <div className="mb-2 text-left text-xs font-medium text-chart-tooltip-foreground">
            {title}
          </div>
        )}
        <div className="space-y-1.5">
          {rows.map((row) => (
            <div
              className="flex items-center justify-between gap-4"
              key={`${row.label}-${row.color}`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="size-[5px] shrink-0 rounded-full"
                  style={{ backgroundColor: row.color }}
                />
                <span className="micro-label text-chart-tooltip-muted">{row.label}</span>
              </div>
              <span className="num text-sm font-medium text-chart-tooltip-foreground">
                {typeof row.value === 'number' ? intFmt(row.value) : row.value}
              </span>
            </div>
          ))}
        </div>

        {children && (
          <div className="mt-2 transition-opacity duration-200 ease-out">{children}</div>
        )}
      </div>
    </div>
  )
}

TooltipContent.displayName = 'TooltipContent'

export default TooltipContent
