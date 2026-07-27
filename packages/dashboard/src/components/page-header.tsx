import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

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
    <section className={cn('flex flex-wrap items-end justify-between gap-2', className)}>
      <div className="min-w-0 max-w-2xl">
        <h2 className="text-sm font-semibold tracking-tight text-balance">{title}</h2>
        <p className="mt-0.5 max-w-prose text-xs leading-5 text-pretty text-muted-foreground">
          {description}
        </p>
      </div>
      {aside}
    </section>
  )
}
