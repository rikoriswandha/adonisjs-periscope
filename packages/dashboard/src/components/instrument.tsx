import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The Instrument vocabulary.
 *
 * Three surface planes (well / chassis / panel) plus a strictly rationed set of
 * signal colours. Everything on every screen is assembled from these, so that
 * two surfaces built by different hands still read as one machine.
 *
 * The rule that keeps it honest: chroma means something. If a pixel is
 * saturated it is reporting status, never decorating a container.
 */

export type Signal = 'error' | 'warn' | 'ok' | 'info' | 'neutral'

export const SIGNAL_TEXT: Record<Signal, string> = {
  error: 'text-sig-error',
  warn: 'text-sig-warn',
  ok: 'text-sig-ok',
  info: 'text-sig-info',
  neutral: 'text-ink-3',
}

export const SIGNAL_BG: Record<Signal, string> = {
  error: 'bg-sig-error',
  warn: 'bg-sig-warn',
  ok: 'bg-sig-ok',
  info: 'bg-sig-info',
  neutral: 'bg-ink-4',
}

/** HTTP status → signal. The single source of truth for status colour. */
export function statusSignal(status: number | null | undefined): Signal {
  if (status === null || status === undefined) return 'neutral'
  if (status >= 500) return 'error'
  if (status >= 400) return 'warn'
  if (status >= 300) return 'info'
  return 'ok'
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Raised plane. Carries a 1px light line along its top edge — the machined
 * panel cue that does the work a brand hue would otherwise do.
 */
export function Panel({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('panel', className)} {...props} />
}

export function PanelHeader({
  title,
  icon,
  action,
  meta,
  className,
  ...props
}: Omit<ComponentProps<'header'>, 'title'> & {
  title: ReactNode
  icon?: ReactNode
  action?: ReactNode
  meta?: ReactNode
}) {
  return (
    <header
      className={cn(
        'flex h-9 shrink-0 items-center gap-2 border-b border-edge px-3 text-ink-2 max-sm:h-auto max-sm:min-h-9 max-sm:flex-wrap max-sm:py-1',
        className
      )}
      {...props}
    >
      {icon && <span className="flex size-3.5 shrink-0 items-center text-ink-3">{icon}</span>}
      <h2 className="micro-label truncate text-ink-2 max-sm:min-w-0 max-sm:flex-1">{title}</h2>
      {meta && <span className="num shrink-0 text-micro text-ink-4">{meta}</span>}
      {action && (
        <div className="ms-auto flex shrink-0 items-center gap-1 max-sm:basis-full max-sm:justify-end">
          {action}
        </div>
      )}
    </header>
  )
}

export function PanelBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-3', className)} {...props} />
}

/** Recessed plane. Data, code, and tables sit *inside* the chassis, not on it. */
export function Well({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('well', className)} {...props} />
}

/* -------------------------------------------------------------------------- */
/* Signal primitives                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A 5px semantic dot. Used instead of a filled pill wherever a value repeats
 * down a column: 200 coloured pills are noise, 200 dots beside mono figures
 * are a scannable pattern.
 */
export function StatusDot({
  signal,
  pulse = false,
  className,
}: {
  signal: Signal
  pulse?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-[5px] shrink-0 rounded-full',
        SIGNAL_BG[signal],
        pulse && 'animate-pulse-dot',
        className
      )}
    />
  )
}

/**
 * Inline magnitude bar. Gives a duration or count a second visual dimension
 * without spending a chart on it.
 */
export function SignalMeter({
  value,
  max,
  signal = 'neutral',
  className,
}: {
  value: number
  max: number
  signal?: Signal
  className?: string
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  return (
    <span
      aria-hidden="true"
      className={cn('block h-0.5 w-full overflow-hidden rounded-full bg-edge', className)}
    >
      <span
        className={cn('block h-full w-full origin-left rounded-full', SIGNAL_BG[signal])}
        style={{
          /* scaleX rather than width: animating width thrashes layout. */
          transform: `scaleX(${ratio})`,
          transition: 'transform var(--dur-slow) var(--ease-out-quart)',
        }}
      />
    </span>
  )
}

/**
 * A key figure. The numeral is monospaced and figure-aligned so a column of
 * these stays optically stable while values tick.
 */
export function Metric({
  label,
  value,
  unit,
  signal = 'neutral',
  detail,
  className,
}: {
  label: string
  value: ReactNode
  unit?: string
  signal?: Signal
  detail?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="micro-label truncate">{label}</span>
      <span className="flex items-baseline gap-1">
        <span
          className={cn(
            'num text-xl leading-none font-medium tracking-tight',
            signal === 'neutral' ? 'text-ink' : SIGNAL_TEXT[signal]
          )}
        >
          {value}
        </span>
        {unit && <span className="num text-xs text-ink-3">{unit}</span>}
      </span>
      {detail && <span className="truncate text-xs text-ink-3">{detail}</span>}
    </div>
  )
}

/**
 * HTTP verb. Fixed width so that paths in adjacent cells align down the
 * column — the difference between a table you read and one you scan.
 */
const METHOD_SIGNAL: Record<string, Signal> = {
  GET: 'neutral',
  HEAD: 'neutral',
  OPTIONS: 'neutral',
  POST: 'ok',
  PUT: 'warn',
  PATCH: 'warn',
  DELETE: 'error',
}

export function MethodTag({ method, className }: { method: string; className?: string }) {
  const normalized = method.toUpperCase()
  return (
    <span
      className={cn(
        'num inline-block w-[3.75rem] shrink-0 text-micro font-medium tracking-wider',
        SIGNAL_TEXT[METHOD_SIGNAL[normalized] ?? 'info'],
        className
      )}
      title={normalized}
    >
      {normalized.length > 6 ? normalized.slice(0, 6) : normalized}
    </span>
  )
}
