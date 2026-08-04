import { BarChart3, ChevronDown } from 'lucide-react'
import { curveLinear } from '@visx/curve'
import { useMemo, useState } from 'react'

import { Grid } from '@/components/charts/grid'
import { LineChart, Line } from '@/components/charts/line-chart'
import { ChartTooltip } from '@/components/charts/tooltip'
import { XAxis } from '@/components/charts/x-axis'
import { MethodTag, Panel, PanelHeader } from '@/components/instrument'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
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
    <Panel aria-labelledby="activity-title" className="overflow-hidden">
      <PanelHeader
        action={<span className="num text-micro text-ink-3">{data.length} samples</span>}
        icon={<BarChart3 aria-hidden="true" className="size-3.5" />}
        id="activity-title"
        title="Request duration"
      />
      <figure>
        <figcaption className="sr-only">
          Recent response times as evenly spaced samples, oldest to newest
        </figcaption>
        <div
          aria-label="Line chart of recent request duration"
          className="h-[200px] px-2 pt-2 sm:px-3"
          role="img"
        >
          <LineChart
            animationDuration={0}
            aspectRatio={null}
            data={data}
            margin={{ top: 16, right: 20, bottom: 36, left: 20 }}
            xDataKey="sample"
          >
            <Grid horizontal numTicksRows={4} />
            <Line
              curve={curveLinear}
              dataKey="duration"
              fadeEdges={false}
              stroke="var(--chart-line-primary)"
            />
            <XAxis numTicks={5} />
            <ChartTooltip
              content={({ point }) => (
                <div className="max-w-80 space-y-1.5 px-3 py-2.5">
                  <p className="micro-label">Duration</p>
                  <p className="num text-micro text-chart-tooltip-muted">
                    {formatDateTime((point.date as Date).toISOString())}
                  </p>
                  <p className="num break-all text-sm leading-snug text-chart-tooltip-foreground">
                    <span className="text-chart-tooltip-muted">{String(point.method)}</span>{' '}
                    {String(point.path)}
                  </p>
                  <p className="num text-xs font-medium text-chart-tooltip-foreground">
                    {formatDuration(point.duration as number)}
                  </p>
                </div>
              )}
              showDatePill={false}
            />
          </LineChart>
        </div>
        <Collapsible onOpenChange={setTableOpen} open={tableOpen}>
          <CollapsibleTrigger className="flex min-h-[var(--control-h)] w-full items-center justify-center gap-1.5 border-t border-edge px-3 text-xs font-medium text-ink-3 outline-none transition-colors duration-[var(--dur-fast)] hover:bg-panel-raised hover:text-ink active:bg-well disabled:pointer-events-none disabled:opacity-50 [@media(pointer:coarse)]:min-h-11">
            {tableOpen ? 'Hide' : 'View'} chart data
            <ChevronDown
              aria-hidden="true"
              className={`size-3.5 transition-transform duration-[var(--dur-base)] ${tableOpen ? 'rotate-180' : ''}`}
            />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="well max-h-64 overflow-auto rounded-none border-x-0 border-b-0">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Request duration data used by the chart</caption>
                <thead className="sticky top-0 bg-well text-ink-3">
                  <tr>
                    <th className="micro-label px-3 py-[var(--cell-py)]" scope="col">
                      When
                    </th>
                    <th className="micro-label px-3 py-[var(--cell-py)]" scope="col">
                      Request
                    </th>
                    <th
                      className="micro-label px-3 py-[var(--cell-py)] text-right"
                      scope="col"
                    >
                      Duration
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge text-ink-2">
                  {data.map((point, index) => (
                    <tr className="h-[var(--row-h)]" key={`${point.date.toISOString()}-${index}`}>
                      <td className="num whitespace-nowrap px-3 py-[var(--cell-py)]">
                        {formatDateTime(point.date.toISOString())}
                      </td>
                      <td className="max-w-md px-3 py-[var(--cell-py)]">
                        <span className="flex min-w-0 items-center gap-2">
                          <MethodTag method={point.method} />
                          <span className="num truncate text-ink">{point.path}</span>
                        </span>
                      </td>
                      <td className="num whitespace-nowrap px-3 py-[var(--cell-py)] text-right text-ink">
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
    </Panel>
  )
}
