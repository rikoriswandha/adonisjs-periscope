import { BarChart3, ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Grid } from '@/components/charts/grid'
import { LineChart, Line } from '@/components/charts/line-chart'
import { ChartTooltip } from '@/components/charts/tooltip'
import { XAxis } from '@/components/charts/x-axis'
import {
  buildHttpClientDurationData,
  isHttpClientFailure,
} from '@/components/http-client-duration-data'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Frame, FramePanel } from '@/components/ui/frame'
import { formatDateTime, formatDuration } from '@/lib/format'
import type { HttpClientContent, StoredEntry } from '@/types'

function HttpClientResult({ content }: { content: HttpClientContent }) {
  if (content.error !== undefined && content.error !== null) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant="destructive">failed</Badge>
        {content.status !== undefined && <StatusBadge status={content.status} />}
      </span>
    )
  }
  if (!content.completed) return <Badge variant="outline">pending</Badge>
  if (content.status !== undefined) return <StatusBadge status={content.status} />
  return <Badge variant="success">completed</Badge>
}

export function HttpClientDurationChart({ entries }: { entries: StoredEntry[] }) {
  const [tableOpen, setTableOpen] = useState(false)
  const data = useMemo(() => buildHttpClientDurationData(entries), [entries])
  const failureCount = data.filter(({ content }) => isHttpClientFailure(content)).length

  if (data.length < 2) return null

  return (
    <Frame className="rounded-lg p-0.5" aria-labelledby="http-client-duration-title">
      <FramePanel className="overflow-hidden rounded-md p-0 shadow-none before:shadow-none">
        <figure>
          <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div>
          <h2
            className="flex items-center gap-2 text-xs font-semibold"
            id="http-client-duration-title"
          >
            <BarChart3 aria-hidden="true" className="size-3.5 text-primary" />
            Outbound request duration
          </h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            Recent response time in milliseconds, oldest to newest. Outcomes are available in the
            data table.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {failureCount > 0 && (
            <Badge variant="destructive">
              {failureCount} {failureCount === 1 ? 'failure' : 'failures'}
            </Badge>
          )}
          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
            {data.length} samples
          </span>
        </div>
      </figcaption>
      <div
        aria-label={`Line chart of ${data.length} outbound request durations, including ${failureCount} ${failureCount === 1 ? 'failure' : 'failures'}`}
        className="px-2 pt-2 sm:px-4"
        role="img"
      >
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
              <caption className="sr-only">
                Outbound HTTP request duration and outcome data used by the chart
              </caption>
              <thead className="sticky top-0 bg-muted text-muted-foreground">
                <tr>
                  <th className="h-8 px-2.5 text-2xs font-medium tracking-wide uppercase">When</th>
                  <th className="h-8 px-2.5 text-2xs font-medium tracking-wide uppercase">Request</th>
                  <th className="h-8 px-2.5 text-2xs font-medium tracking-wide uppercase">Result</th>
                  <th className="h-8 px-2.5 text-right text-2xs font-medium tracking-wide uppercase">
                    Duration
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.map((point, index) => (
                  <tr key={`${point.date.toISOString()}-${index}`}>
                    <td className="whitespace-nowrap px-3 py-2">
                      {formatDateTime(point.date.toISOString())}
                    </td>
                    <td className="max-w-80 truncate px-3 py-2 font-mono" title={point.label}>
                      {point.label}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <HttpClientResult content={point.content} />
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
