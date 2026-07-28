import { BarChart3, ChevronDown } from 'lucide-react'
import { curveLinear } from '@visx/curve'
import { useMemo, useState } from 'react'

import { ChartTooltip } from '@/components/charts/tooltip'
import { Grid } from '@/components/charts/grid'
import { LineChart, Line } from '@/components/charts/line-chart'
import { XAxis } from '@/components/charts/x-axis'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Frame, FramePanel } from '@/components/ui/frame'
import { formatDateTime, formatDuration, sequenceCompareAscending } from '@/lib/format'
import type { RequestContent, StoredEntry } from '@/types'

export function RequestActivityChart({ entries }: { entries: StoredEntry[] }) {
  const [tableOpen, setTableOpen] = useState(false)
  const data = useMemo(() => {
    const points = [...entries]
      .sort((left, right) => {
        const byDate = left.createdAt.localeCompare(right.createdAt)
        return byDate !== 0 ? byDate : sequenceCompareAscending(left.sequence, right.sequence)
      })
      .map((entry) => {
        const content = entry.content as RequestContent
        return {
          // Wall-clock timestamps often collide within a burst; space samples evenly
          // so the line stays readable oldest → newest.
          sample: new Date(0),
          date: new Date(entry.createdAt),
          duration: content.durationMs,
          method: content.method,
          path: content.url,
        }
      })
      .filter((point) => Number.isFinite(point.duration))

    return points.map((point, index) => ({ ...point, sample: new Date(index) }))
  }, [entries])

  if (data.length < 2) return null

  return (
    <Frame className="rounded-lg p-0.5" aria-labelledby="activity-title">
      <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
        <figure>
          <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <div>
              <h2 className="flex items-center gap-2 text-xs font-semibold" id="activity-title">
                <BarChart3 aria-hidden="true" className="size-3.5 text-primary" />
                Request duration
              </h2>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                Recent response times as evenly spaced samples, oldest to newest
              </p>
            </div>
            <span className="font-mono text-2xs tabular-nums text-muted-foreground">
              {data.length} samples
            </span>
          </figcaption>
          <div
            className="px-2 pt-2 sm:px-4"
            role="img"
            aria-label="Line chart of recent request duration"
          >
            <LineChart
              animationDuration={0}
              aspectRatio="3 / 1"
              data={data}
              margin={{ top: 16, right: 20, bottom: 36, left: 20 }}
              xDataKey="sample"
            >
              <Grid horizontal numTicksRows={4} />
              <Line curve={curveLinear} dataKey="duration" fadeEdges={false} stroke="var(--chart-line-primary)" />
              <XAxis numTicks={5} />
              <ChartTooltip
                content={({ point }) => (
                  <div className="max-w-80 space-y-1.5 px-2.5 py-2">
                    <p className="text-2xs text-chart-tooltip-muted">
                      {formatDateTime((point.date as Date).toISOString())}
                    </p>
                    <p className="break-all font-mono text-sm font-medium leading-snug text-chart-tooltip-foreground">
                      <span className="text-2xs font-normal text-chart-tooltip-muted">{String(point.method)}</span>{' '}
                      {String(point.path)}
                    </p>
                    <p className="font-mono text-xs tabular-nums text-chart-tooltip-foreground">
                      {formatDuration(point.duration as number)}
                    </p>
                  </div>
                )}
                showDatePill={false}
              />
            </LineChart>
          </div>
          <Collapsible onOpenChange={setTableOpen} open={tableOpen}>
            <CollapsibleTrigger className="flex w-full items-center justify-center gap-1.5 border-t px-3 py-1.5 text-2xs font-medium text-muted-foreground outline-none hover:bg-accent/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              {tableOpen ? 'Hide' : 'View'} chart data
              <ChevronDown
                aria-hidden="true"
                className={`size-3.5 transition-transform ${tableOpen ? 'rotate-180' : ''}`}
              />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="max-h-64 overflow-auto border-t">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">When</th>
                      <th className="px-3 py-2 font-medium">Request</th>
                      <th className="px-3 py-2 text-right font-medium">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.map((point, index) => (
                      <tr key={`${point.date.toISOString()}-${index}`}>
                        <td className="whitespace-nowrap px-3 py-2">
                          {formatDateTime(point.date.toISOString())}
                        </td>
                        <td className="max-w-md break-all px-3 py-2 font-mono">
                          <span className="text-muted-foreground">{point.method}</span> {point.path}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums">
                          {formatDuration(point.duration)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </figure>
      </FramePanel>
    </Frame>
  )
}
