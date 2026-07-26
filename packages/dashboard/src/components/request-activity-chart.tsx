import { BarChart3, ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'

import { ChartTooltip } from '@/components/charts/tooltip'
import { Grid } from '@/components/charts/grid'
import { LineChart, Line } from '@/components/charts/line-chart'
import { XAxis } from '@/components/charts/x-axis'
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { formatDateTime, formatDuration, sequenceCompareAscending } from '@/lib/format'
import type { RequestContent, StoredEntry } from '@/types'

export function RequestActivityChart({ entries }: { entries: StoredEntry[] }) {
  const [tableOpen, setTableOpen] = useState(false)
  const data = useMemo(
    () =>
      [...entries]
        .sort((left, right) => sequenceCompareAscending(left.sequence, right.sequence))
        .map((entry) => ({
          date: new Date(entry.createdAt),
          duration: (entry.content as RequestContent).durationMs,
          label: (entry.content as RequestContent).url,
        }))
        .filter((point) => Number.isFinite(point.duration)),
    [entries]
  )

  if (data.length < 2) return null

  return (
    <figure className="overflow-hidden rounded-lg border bg-background" aria-labelledby="activity-title">
      <figcaption className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold" id="activity-title">
            <BarChart3 aria-hidden="true" className="size-4 text-primary" />
            Request duration
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Recent response time in milliseconds, oldest to newest
          </p>
        </div>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {data.length} samples
        </span>
      </figcaption>
      <div className="px-2 pt-2 sm:px-4" role="img" aria-label="Line chart of recent request duration">
        <LineChart
          animationDuration={0}
          aspectRatio="3 / 1"
          data={data}
          margin={{ top: 16, right: 20, bottom: 36, left: 20 }}
        >
          <Grid horizontal numTicksRows={4} />
          <Line dataKey="duration" fadeEdges={false} stroke="var(--chart-line-primary)" />
          <XAxis numTicks={5} />
          <ChartTooltip />
        </LineChart>
      </div>
      <Collapsible onOpenChange={setTableOpen} open={tableOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-center gap-1.5 border-t px-3 py-2 text-xs font-medium text-muted-foreground outline-none hover:bg-accent/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
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
                    <td className="whitespace-nowrap px-3 py-2">{formatDateTime(point.date.toISOString())}</td>
                    <td className="max-w-80 truncate px-3 py-2 font-mono">{point.label}</td>
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
  )
}
