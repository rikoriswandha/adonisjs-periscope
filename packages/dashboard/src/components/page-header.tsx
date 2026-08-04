import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Page titles sit at the top of a dense scanning surface, so hierarchy comes
 * from weight and space rather than size. The description is capped at a
 * readable measure and is the one place on an index page that runs as prose.
 */
export function PageHeader({
  title,
  description,
  aside,
  className,
}: {
  title: string
  description: string
  aside?: ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex flex-wrap items-start justify-between gap-x-6 gap-y-2', className)}>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-balance text-ink">{title}</h2>
        <p className="mt-1 max-w-[68ch] text-sm leading-5 text-pretty text-ink-3">{description}</p>
      </div>
      {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </section>
  )
}
