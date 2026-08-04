import { Clock3 } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  Panel,
  PanelBody,
  PanelHeader,
  SIGNAL_BG,
  SIGNAL_TEXT,
  StatusDot,
  Well,
  type Signal,
} from '@/components/instrument'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip'
import { asNumber, formatDuration, sequenceCompareAscending } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { EntryType, StoredEntry } from '@/types'
import { entryTypeLabel } from '@/wave2-entry-types'

const AXIS_TICK_COUNT = 5

const signalByType: Record<EntryType, Signal> = {
  request: 'neutral',
  query: 'warn',
  exception: 'error',
  log: 'neutral',
  event: 'info',
  command: 'neutral',
  mail: 'ok',
  cache: 'warn',
  model: 'ok',
  gate: 'info',
  dump: 'neutral',
  view: 'neutral',
  http_client: 'info',
  schedule: 'warn',
  job: 'ok',
  broadcast: 'info',
  health_check: 'ok',
  redis: 'error',
  session: 'neutral',
  validation: 'error',
  rate_limit: 'warn',
  lock: 'warn',
  drive: 'info',
  ally: 'neutral',
  i18n: 'neutral',
  notification: 'ok',
  socket: 'info',
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


function buildWaterfallLayout(entries: StoredEntry[]): WaterfallLayout {
  const validTimestamps = entries
    .map((entry) => Date.parse(entry.createdAt))
    .filter((value) => Number.isFinite(value))
  const originMs = validTimestamps.length > 0 ? Math.min(...validTimestamps) : 0
  const laneEnds: number[] = []
  const lanes: WaterfallItem[][] = []

  const items = entries
    .map((entry) => {
      const parsedStart = Date.parse(entry.createdAt)
      const startMs = (Number.isFinite(parsedStart) ? parsedStart : originMs) - originMs
      const parsedDuration = asNumber(entry.content.durationMs)
      const durationMs =
        parsedDuration !== undefined && parsedDuration >= 0 ? parsedDuration : undefined
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
  const signal = signalByType[item.entry.type]
  return (
    <div className="max-w-80 space-y-1 px-1 py-0.5">
      <p className={cn('flex items-center gap-1.5 text-micro font-medium', SIGNAL_TEXT[signal])}>
        <StatusDot signal={signal} />
        {entryTypeLabel(item.entry.type)}
      </p>
      <p className="num break-words text-xs font-medium text-ink">{summary(item.entry)}</p>
      <p className="num text-micro text-ink-3">
        +{formatOffset(item.startMs)}
        {' · '}
        {item.durationMs === undefined ? 'Instant' : formatDuration(item.durationMs)}
      </p>
    </div>
  )
}

function WaterfallBar({
  dimmed,
  item,
  onHover,
  onSelect,
  summary,
  totalSpanMs,
}: {
  dimmed: boolean
  item: WaterfallItem
  onHover: (uuid: string | null) => void
  onSelect: (entry: StoredEntry) => void
  summary: (entry: StoredEntry) => string
  totalSpanMs: number
}) {
  const domainMs = totalSpanMs > 0 ? totalSpanMs : 1
  const left = (item.startMs / domainMs) * 100
  const width = ((item.durationMs ?? 0) / domainMs) * 100
  const signal = signalByType[item.entry.type]
  const type = entryTypeLabel(item.entry.type)
  const label = summary(item.entry)
  const timingLabel =
    item.durationMs === undefined
      ? `at +${formatOffset(item.startMs)}, instant`
      : `at +${formatOffset(item.startMs)}, duration ${formatDuration(item.durationMs)}`
  const edgePosition =
    left === 0 ? 'translate-x-0' : left === 100 ? '-translate-x-full' : '-translate-x-1/2'

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={`Open ${type}: ${label}, ${timingLabel}`}
            className={cn(
              'absolute top-1/2 h-7 -translate-y-1/2 rounded-sm outline-none transition-[opacity,filter,box-shadow] duration-[var(--dur-fast)] hover:brightness-110 focus-visible:z-[var(--z-raised)] focus-visible:ring-2 focus-visible:ring-sig-info focus-visible:ring-offset-1 focus-visible:ring-offset-well [@media(pointer:coarse)]:h-11',
              item.durationMs === undefined ? cn('w-1', edgePosition) : 'min-w-[3px]',
              SIGNAL_BG[signal],
              dimmed && 'opacity-20'
            )}
            data-entry-type={item.entry.type}
            data-waterfall-kind={item.durationMs === undefined ? 'instant' : 'duration'}
            onBlur={() => onHover(null)}
            onClick={() => onSelect(item.entry)}
            onFocus={() => onHover(item.entry.uuid)}
            onMouseEnter={() => onHover(item.entry.uuid)}
            onMouseLeave={() => onHover(null)}
            style={{
              left: `${left}%`,
              ...(item.durationMs === undefined ? {} : { width: `max(${width}%, 3px)` }),
            }}
            type="button"
          />
        }
      />
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
  const [hoveredUuid, setHoveredUuid] = useState<string | null>(null)
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
    <Panel aria-labelledby="batch-waterfall-title">
      <PanelHeader
        action={
          <span className="num text-micro text-ink-3">
            {timeline.length} {timeline.length === 1 ? 'entry' : 'entries'} ·{' '}
            {layout.lanes.length} {layout.lanes.length === 1 ? 'lane' : 'lanes'}
          </span>
        }
        icon={<Clock3 aria-hidden="true" className="size-3.5" />}
        id="batch-waterfall-title"
        meta={`${formatOffset(layout.totalSpanMs)} total`}
        title="Batch waterfall"
      />
      <PanelBody className="p-0">
        <figure>
          <figcaption className="sr-only">
            Entry start offsets and durations in sequence order
          </figcaption>
          <Well className="overflow-x-auto rounded-none border-0" role="group" aria-label="Batch waterfall chart">
            <div className="min-w-[56rem]">
              <div className="grid grid-cols-[minmax(12rem,22rem)_minmax(28rem,1fr)_5.5rem] border-b border-edge">
                <div className="micro-label flex h-9 items-end px-3 pb-2">Entry</div>
                <div className="relative h-9" aria-label="Elapsed time axis">
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
                          'num absolute bottom-2 whitespace-nowrap text-micro text-ink-4',
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
                <div className="micro-label flex h-9 items-end justify-end px-3 pb-2">Duration</div>
              </div>

              {layout.items.length === 0 ? (
                <p className="p-6 text-center text-sm text-ink-3" role="status">
                  No entries were recorded in this batch.
                </p>
              ) : (
                <div>
                  {layout.items.map((item) => {
                    const signal = signalByType[item.entry.type]
                    const itemSummary = summary(item.entry)
                    return (
                      <div
                        className={cn(
                          'grid min-h-[var(--row-h)] grid-cols-[minmax(12rem,22rem)_minmax(28rem,1fr)_5.5rem] border-b border-edge last:border-b-0 transition-opacity duration-[var(--dur-fast)] [@media(pointer:coarse)]:min-h-11',
                          hoveredUuid && hoveredUuid !== item.entry.uuid && 'opacity-35'
                        )}
                        key={item.entry.uuid}
                      >
                        <div className="flex min-w-0 items-center gap-2 px-3 py-[var(--cell-py)]">
                          <StatusDot signal={signal} />
                          <span className="w-20 shrink-0 truncate text-micro text-ink-3">
                            {entryTypeLabel(item.entry.type)}
                          </span>
                          <span className="num min-w-0 truncate text-xs text-ink" title={itemSummary}>
                            {itemSummary}
                          </span>
                        </div>
                        <div className="relative min-h-[var(--row-h)] [@media(pointer:coarse)]:min-h-11">
                          {ticks.map((tick, index) => {
                            const left =
                              layout.totalSpanMs === 0 ? 0 : (tick / layout.totalSpanMs) * 100
                            return (
                              <span
                                aria-hidden="true"
                                className="pointer-events-none absolute inset-y-0 w-px bg-edge/60"
                                key={`${tick}-${index}`}
                                style={{ left: `${left}%` }}
                              />
                            )
                          })}
                          <WaterfallBar
                            dimmed={hoveredUuid !== null && hoveredUuid !== item.entry.uuid}
                            item={item}
                            onHover={setHoveredUuid}
                            onSelect={onSelect}
                            summary={summary}
                            totalSpanMs={layout.totalSpanMs}
                          />
                        </div>
                        <div className="num flex items-center justify-end px-3 py-[var(--cell-py)] text-right text-xs text-ink-2">
                          {item.durationMs === undefined ? 'Instant' : formatDuration(item.durationMs)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </Well>

          {types.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-edge px-3 py-2" aria-label="Entry type legend">
              {types.map((type) => (
                <span className="inline-flex items-center gap-1.5 text-micro text-ink-3" key={type}>
                  <StatusDot signal={signalByType[type]} />
                  {entryTypeLabel(type)}
                </span>
              ))}
            </div>
          )}
        </figure>
      </PanelBody>
    </Panel>
  )
}
