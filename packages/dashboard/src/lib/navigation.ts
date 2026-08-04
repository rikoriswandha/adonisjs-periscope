import { BellRing, Bug, Database, Gauge, LayoutDashboard } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { EntryType } from '@/types'
import { wave2EntryTypes } from '@/wave2-entry-types'

export type NavigationItem = {
  to: string
  label: string
  type?: EntryType
  icon: LucideIcon
}

export type NavigationGroup = {
  label: string
  items: NavigationItem[]
}

/**
 * One navigation model, consumed by both the rail and the command palette, so
 * that a watcher added to the registry appears in both without a second edit.
 */
export const navigationGroups: NavigationGroup[] = [
  {
    label: 'Core',
    items: [
      { to: '/overview', label: 'Overview', icon: LayoutDashboard },
      { to: '/requests', label: 'Requests', type: 'request', icon: Gauge },
      { to: '/queries', label: 'Queries', type: 'query', icon: Database },
      { to: '/exceptions', label: 'Exceptions', type: 'exception', icon: Bug },
    ],
  },
  ...(['Application', 'Infrastructure', 'Diagnostics'] as const).map((label) => ({
    label,
    items: [
      ...wave2EntryTypes
        .filter((registration) => registration.group === label)
        .map((registration) => ({
          to: `/${registration.path}`,
          label: registration.label,
          type: registration.type,
          icon: registration.icon,
        })),
      ...(label === 'Diagnostics'
        ? [{ to: '/monitored-tags', label: 'Monitored tags', icon: BellRing }]
        : []),
    ],
  })),
]

export const navigationItems: NavigationItem[] = navigationGroups.flatMap((group) => group.items)

export const titleByPath: Record<string, string> = {
  search: 'Search',
  ...Object.fromEntries(navigationItems.map((item) => [item.to.replace(/^\//, ''), item.label])),
}
