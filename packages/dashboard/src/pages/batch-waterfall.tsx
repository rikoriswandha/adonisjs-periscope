import { Clock3 } from 'lucide-react'
import { useMemo } from 'react'

import { Frame, FramePanel } from '@/components/ui/frame'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { asNumber, formatDuration, sequenceCompareAscending } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { EntryType, StoredEntry } from '@/types'
import { entryTypeLabel } from '@/wave2-entry-types'

const AXIS_TICK_COUNT = 5

const typePalette = {
  destructive: {
    bar: 'border-destructive/40 bg-destructive/12 text-destructive-foreground dark:bg-destructive/20',
    dot: 'bg-destructive',
  },
  info: {
    bar: 'border-info/40 bg-info/12 text-info-foreground dark:bg-info/20',
    dot: 'bg-info',
  },
  primary: {
    bar: 'border-primary/40 bg-primary/12 text-primary dark:bg-primary/20',
    dot: 'bg-primary',
  },
  secondary: {
    bar: 'border-border bg-secondary text-secondary-foreground',
    dot: 'bg-muted-foreground',
  },
  success: {
    bar: 'border-success/40 bg-success/12 text-success-foreground dark:bg-success/20',
    dot: 'bg-success',
  },
  warning: {
    bar: 'border-warning/40 bg-warning/12 text-warning-foreground dark:bg-warning/20',
    dot: 'bg-warning',
  },
} as const

type PaletteName = keyof typeof typePalette

/**
 * Entry colors follow the semantic coss badge palette so the waterfall reads like
 * the rest of the dashboard instead of introducing a chart-only color language.
 */
const paletteByType: Record<EntryType, PaletteName> = {
  request: 'primary',
  query: 'warning',
  exception: 'destructive',
  log: 'secondary',
  event: 'info',
  command: 'secondary',
  mail: 'success',
  cache: 'warning',
  model: 'success',
  gate: 'info',
  dump: 'secondary',
  view: 'primary',
  http_client: 'info',
  schedule: 'warning',
  job: 'success',
  broadcast: 'info',
  health_check: 'success',
  redis: 'destructive',
  session: 'secondary',
}

type WaterfallItem = {
  entry: StoredEntry
  startMs: number
  endMs: number
  durationMs: number | undefined
  lane: number
}

type WaterfallLayout = {
  items: WaterfallItem[]
  lanes: WaterfallItem[][]
  totalSpanMs: number
}

function entryDuration(entry: StoredEntry): number | undefined {
  const duration = asNumber(entry.content.durationMs)
  return duration !== undefined && duration >= 0 ? duration : undefined
}

function timestamp(entry: StoredEntry): number | undefined {
  const value = Date.parse(entry.createdAt)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Reusing the first available lane keeps the chart compact while preserving
 * temporal overlap: entries that are active together can never occupy one lane.
 */
function buildWaterfallLayout(entries: StoredEntry[]): WaterfallLayout {
  const validTimestamps = entries.map(timestamp).filter((value) => value !== undefined)
  const originMs = validTimestamps.length > 0 ? Math.min(...validTimestamps) : 0
  const laneEnds: number[] = []
  const lanes: WaterfallItem[][] = []

  const items = entries
    .map((entry) => {
      const startMs = (timestamp(entry) ?? originMs) - originMs
      const durationMs = entryDuration(entry)
      return {
        entry,
        startMs,
        endMs: startMs + (durationMs ?? 0),
        durationMs,
      }
    })
    .sort((left, right) => {
      if (left.startMs !== right.startMs) return left.startMs - right.startMs
      return sequenceCompareAscending(left.entry.sequence, right.entry.sequence)
    })
    .map((item) => {
      const lane = laneEnds.findIndex((laneEnd) => laneEnd <= item.startMs)
      const laneIndex = lane === -1 ? laneEnds.length : lane
      // A sub-millisecond occupancy keeps simultaneous instant markers from hiding each other.
      laneEnds[laneIndex] = item.endMs > item.startMs ? item.endMs : item.startMs + 0.001
      const packed = { ...item, lane: laneIndex }
      ;(lanes[laneIndex] ??= []).push(packed)
      return packed
    })

  const totalSpanMs = items.reduce((span, item) => Math.max(span, item.endMs), 0)
  return { items, lanes, totalSpanMs }
}

function formatOffset(value: number): string {
  return value === 0 ? '0 ms' : formatDuration(value)
}

function WaterfallTooltip({
  item,
  summary,
}: {
  item: WaterfallItem
  summary: (entry: StoredEntry) => string
}) {
  const type = entryTypeLabel(item.entry.type)
  const offset = formatOffset(item.startMs)

  return (
    <div className="max-w-80 space-y-1 px-1 py-0.5">
      <p className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
        <span
          aria-hidden="true"
          className={cn('size-1.5 rounded-full', typePalette[paletteByType[item.entry.type]].dot)}
        />
        {type}
      </p>
      <p className="break-words text-xs font-medium text-foreground">{summary(item.entry)}</p>
      <p className="font-mono text-2xs tabular-nums text-muted-foreground">
        +{offset}
        {' · '}
        {item.durationMs === undefined ? 'Instant' : formatDuration(item.durationMs)}
      </p>
    </div>
  )
}

function WaterfallEntry({
  item,
  summary,
  totalSpanMs,
  onSelect,
}: {
  item: WaterfallItem
  summary: (entry: StoredEntry) => string
  totalSpanMs: number
  onSelect: (entry: StoredEntry) => void
}) {
  const domainMs = totalSpanMs > 0 ? totalSpanMs : 1
  const left = (item.startMs / domainMs) * 100
  const width = ((item.durationMs ?? 0) / domainMs) * 100
  const palette = typePalette[paletteByType[item.entry.type]]
  const type = entryTypeLabel(item.entry.type)
  const label = summary(item.entry)
  const timingLabel =
    item.durationMs === undefined
      ? `at +${formatOffset(item.startMs)}, instant`
      : `at +${formatOffset(item.startMs)}, duration ${formatDuration(item.durationMs)}`

  if (item.durationMs === undefined) {
    const edgePosition =
      left === 0 ? 'translate-x-0' : left === 100 ? '-translate-x-full' : '-translate-x-1/2'
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={`Open ${type}: ${label}, ${timingLabel}`}
              className={cn(
                'absolute top-1 flex h-8 w-5 items-center justify-center rounded-sm outline-none hover:bg-accent/55 focus-visible:z-10 focus-visible:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                edgePosition
              )}
              data-entry-type={item.entry.type}
              data-waterfall-kind="instant"
              onClick={() => onSelect(item.entry)}
              style={{ left: `${left}%` }}
              type="button"
            />
          }
        >
          <span aria-hidden="true" className={cn('h-6 w-0.5 rounded-full', palette.dot)} />
        </TooltipTrigger>
        <TooltipPopup side="top">
          <WaterfallTooltip item={item} summary={summary} />
        </TooltipPopup>
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={`Open ${type}: ${label}, ${timingLabel}`}
            className={cn(
              'absolute top-1 flex h-8 min-w-1.5 items-center overflow-hidden rounded-sm border px-1.5 text-left text-2xs font-medium outline-none transition-[filter,box-shadow] hover:brightness-95 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              palette.bar
            )}
            data-entry-type={item.entry.type}
            data-waterfall-kind="duration"
            onClick={() => onSelect(item.entry)}
            style={{ left: `${left}%`, width: `${width}%` }}
            type="button"
          />
        }
      >
        <span className="truncate">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <WaterfallTooltip item={item} summary={summary} />
      </TooltipPopup>
    </Tooltip>
  )
}

export function BatchWaterfall({
  timeline,
  onSelect,
  summary,
}: {
  timeline: StoredEntry[]
  onSelect: (entry: StoredEntry) => void
  summary: (entry: StoredEntry) => string
}) {
  const layout = useMemo(() => buildWaterfallLayout(timeline), [timeline])
  const ticks = useMemo(() => {
    if (layout.totalSpanMs === 0) return [0]
    return Array.from(
      { length: AXIS_TICK_COUNT },
      (_, index) => (layout.totalSpanMs * index) / (AXIS_TICK_COUNT - 1)
    )
  }, [layout.totalSpanMs])
  const types = [...new Set(layout.items.map((item) => item.entry.type))]

  return (
    <Frame aria-labelledby="batch-waterfall-title" className="rounded-lg p-0.5">
      <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
        <figure>
          <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <div>
              <h2
                className="flex items-center gap-2 text-xs font-semibold"
                id="batch-waterfall-title"
              >
                <Clock3 aria-hidden="true" className="size-3.5 text-primary" />
                Batch waterfall
              </h2>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                Entry start offsets and durations, packed into parallel lanes
              </p>
            </div>
            <div className="text-right font-mono text-2xs tabular-nums text-muted-foreground">
              <span className="block text-xs font-medium text-foreground">
                {formatOffset(layout.totalSpanMs)} total
              </span>
              {timeline.length} {timeline.length === 1 ? 'entry' : 'entries'} ·{' '}
              {layout.lanes.length} {layout.lanes.length === 1 ? 'lane' : 'lanes'}
            </div>
          </figcaption>

          <div className="overflow-x-auto" role="group" aria-label="Batch waterfall chart">
            <div className="min-w-data-table">
              <div className="grid grid-cols-4 border-b bg-muted/35">
                <div className="flex h-9 items-end px-3 pb-2 text-2xs font-medium text-muted-foreground">
                  Lane
                </div>
                <div className="relative col-span-3 h-9" aria-label="Elapsed time axis">
                  {ticks.map((tick, index) => {
                    const left = layout.totalSpanMs === 0 ? 0 : (tick / layout.totalSpanMs) * 100
                    const alignment =
                      index === 0
                        ? 'translate-x-0'
                        : index === ticks.length - 1
                          ? '-translate-x-full'
                          : '-translate-x-1/2'
                    return (
                      <span
                        className={cn(
                          'absolute bottom-2 whitespace-nowrap font-mono text-2xs tabular-nums text-muted-foreground',
                          alignment
                        )}
                        key={`${tick}-${index}`}
                        style={{ left: `${left}%` }}
                      >
                        +{formatOffset(tick)}
                      </span>
                    )
                  })}
                </div>
              </div>

              {layout.lanes.map((lane, laneIndex) => (
                <div className="grid grid-cols-4 border-b last:border-b-0" key={laneIndex}>
                  <div className="flex h-10 items-center justify-between gap-2 px-3 text-2xs text-muted-foreground">
                    <span className="font-medium text-foreground">Lane {laneIndex + 1}</span>
                    <span className="font-mono tabular-nums">{lane.length}</span>
                  </div>
                  <div className="relative col-span-3 h-10 bg-chart-background">
                    {ticks.map((tick, index) => {
                      const left = layout.totalSpanMs === 0 ? 0 : (tick / layout.totalSpanMs) * 100
                      return (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-y-0 w-px bg-chart-grid"
                          key={`${tick}-${index}`}
                          style={{ left: `${left}%` }}
                        />
                      )
                    })}
                    {lane.map((item) => (
                      <WaterfallEntry
                        item={item}
                        key={item.entry.uuid}
                        onSelect={onSelect}
                        summary={summary}
                        totalSpanMs={layout.totalSpanMs}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            className="flex flex-wrap gap-x-3 gap-y-1 border-t bg-muted/25 px-3 py-2"
            aria-label="Entry type legend"
          >
            {types.map((type) => (
              <span
                className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground"
                key={type}
              >
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 rounded-full', typePalette[paletteByType[type]].dot)}
                />
                {entryTypeLabel(type)}
              </span>
            ))}
          </div>
        </figure>
      </FramePanel>
    </Frame>
  )
}
