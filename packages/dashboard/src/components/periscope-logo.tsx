import logoMark from '@/assets/periscope-logo.svg'
import { cn } from '@/lib/utils'

type PeriscopeLogoProps = {
  className?: string
  title?: string
}

/** Sidebar / chrome mark. Vector recreation of the generated Periscope lens lock. */
export function PeriscopeLogo({ className, title = 'Periscope' }: PeriscopeLogoProps) {
  return (
    <img
      alt=""
      className={cn('size-7 shrink-0 object-contain', className)}
      decoding="async"
      height={28}
      src={logoMark}
      title={title}
      width={28}
    />
  )
}
