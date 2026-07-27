import { BellRing, BellOff } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { useDashboard } from '@/dashboard-context'

export function TagChip({ tag }: { tag: string }) {
  const { monitoredTags, monitoredTagsReady, monitoringTags, toggleTagMonitoring } = useDashboard()
  const monitored = monitoredTags.includes(tag)
  const pending = !monitoredTagsReady || monitoringTags.includes(tag)
  const action = monitored ? 'Stop monitoring' : 'Monitor'

  return (
    <Badge
      aria-label={`${action} exact tag ${tag}`}
      aria-pressed={monitored}
      aria-busy={pending}
      title={`${action} this exact tag`}
      render={<button disabled={pending} type="button" />}
      variant={monitored ? 'success' : 'outline'}
      onClick={(event) => {
        event.stopPropagation()
        void toggleTagMonitoring(tag)
      }}
    >
      {monitored ? <BellOff aria-hidden="true" /> : <BellRing aria-hidden="true" />}
      <span className="font-mono">{tag}</span>
      <span className="sr-only">{pending ? ' (updating)' : ''}</span>
    </Badge>
  )
}

export function EntryTagChips({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null

  return (
    <section aria-label="Entry tags" className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">Tags</h3>
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <TagChip key={tag} tag={tag} />
        ))}
      </div>
    </section>
  )
}
