import { Bell, BellOff } from 'lucide-react'

import { StatusDot } from '@/components/instrument'
import { useDashboard } from '@/dashboard-context'
import { cn } from '@/lib/utils'

/**
 * A tag is a filter handle first and a label second, so it renders as a
 * monospaced key on a recessed chip. Monitoring state is the only thing here
 * allowed to spend colour.
 */
export function TagChip({ tag }: { tag: string }) {
  const { monitoredTags, monitoredTagsReady, monitoringTags, toggleTagMonitoring } = useDashboard()
  const monitored = monitoredTags.includes(tag)
  const pending = !monitoredTagsReady || monitoringTags.includes(tag)
  const action = monitored ? 'Stop monitoring' : 'Monitor'

  return (
    <button
      aria-label={`${action} exact tag ${tag}`}
      aria-pressed={monitored}
      aria-busy={pending}
      className={cn(
        'group inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 rounded-sm border px-1.5',
        'text-micro transition-colors duration-(--dur-fast) ease-(--ease-out-quart)',
        'disabled:pointer-events-none disabled:opacity-60',
        monitored
          ? 'border-sig-ok/35 bg-sig-ok/10 text-sig-ok'
          : 'border-edge bg-well text-ink-2 hover:border-edge-strong hover:text-ink'
      )}
      disabled={pending}
      onClick={(event) => {
        event.stopPropagation()
        void toggleTagMonitoring(tag)
      }}
      title={`${action} this exact tag`}
      type="button"
    >
      {monitored ? <StatusDot signal="ok" /> : null}
      <span className="num truncate">{tag}</span>
      {monitored ? (
        <BellOff aria-hidden="true" className="size-2.5 shrink-0 opacity-0 group-hover:opacity-70" />
      ) : (
        <Bell aria-hidden="true" className="size-2.5 shrink-0 opacity-0 group-hover:opacity-70" />
      )}
      <span className="sr-only">{pending ? ' (updating)' : ''}</span>
    </button>
  )
}

export function EntryTagChips({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null

  return (
    <section aria-label="Entry tags" className="space-y-1.5">
      <h3 className="micro-label">Tags</h3>
      <div className="flex flex-wrap gap-1">
        {tags.map((tag) => (
          <TagChip key={tag} tag={tag} />
        ))}
      </div>
    </section>
  )
}
