import {
  ArrowDown,
  ArrowUp,
  CircleHelp,
  CirclePause,
  CirclePlay,
  CornerDownLeft,
  Monitor,
  Moon,
  Rows2,
  Rows3,
  Search,
  Sun,
  Trash2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Fragment, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useDashboard } from '@/dashboard-context'
import { globalSearchTarget } from '@/lib/global-search'
import { navigationGroups } from '@/lib/navigation'
import type { Density, ThemePreference } from '@/lib/preferences'

type PaletteItem = {
  value: string
  label: string
  hint?: string
  shortcut?: string
  icon: LucideIcon
  run: () => void
}

type PaletteGroup = { value: string; items: PaletteItem[] }

/**
 * ⌘K. Every navigation target and every global action reachable without
 * leaving the keyboard — the affordance that separates a tool an engineer
 * lives in from a page they visit.
 */
export function CommandPalette({
  open,
  onOpenChange,
  theme,
  onThemeChange,
  density,
  onDensityChange,
  onClearRequest,
  onShortcutHelp,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void
  density: Density
  onDensityChange: (density: Density) => void
  onClearRequest: () => void
  onShortcutHelp: () => void
}) {
  const navigate = useNavigate()
  const { counts, status, mutating, togglePaused, selectedApplication } = useDashboard()

  const groups = useMemo<PaletteGroup[]>(() => {
    const close = (run: () => void) => () => {
      onOpenChange(false)
      run()
    }

    const search = new URLSearchParams({ application: selectedApplication }).toString()
    const paused = status?.paused ?? false

    return [
      ...navigationGroups.map((group) => ({
        value: group.label,
        items: group.items.map((item) => {
          const count = item.type ? counts[item.type] : undefined
          return {
            value: `${group.label} ${item.label}`,
            label: item.label,
            hint: count === undefined ? undefined : count.toLocaleString(),
            icon: item.icon,
            run: close(() => navigate(`${item.to}?${search}`)),
          }
        }),
      })),
      {
        value: 'Recording',
        items: [
          {
            value: paused ? 'Resume recording' : 'Pause recording',
            label: paused ? 'Resume recording' : 'Pause recording',
            icon: paused ? CirclePlay : CirclePause,
            run: close(() => {
              if (!mutating) void togglePaused(!paused)
            }),
          },
          {
            value: 'Clear recorded entries',
            label: `Clear entries for ${selectedApplication}`,
            icon: Trash2,
            run: close(onClearRequest),
          },
        ],
      },
      {
        value: 'Appearance',
        items: [
          {
            value: 'Theme dark',
            label: 'Dark theme',
            hint: theme === 'dark' ? 'Active' : undefined,
            icon: Moon,
            run: close(() => onThemeChange('dark')),
          },
          {
            value: 'Theme light',
            label: 'Light theme',
            hint: theme === 'light' ? 'Active' : undefined,
            icon: Sun,
            run: close(() => onThemeChange('light')),
          },
          {
            value: 'Theme system',
            label: 'Match system theme',
            hint: theme === 'system' ? 'Active' : undefined,
            icon: Monitor,
            run: close(() => onThemeChange('system')),
          },
          {
            value: 'Density compact',
            label: 'Compact rows',
            hint: density === 'compact' ? 'Active' : undefined,
            icon: Rows3,
            run: close(() => onDensityChange('compact')),
          },
          {
            value: 'Density comfortable',
            label: 'Comfortable rows',
            hint: density === 'comfortable' ? 'Active' : undefined,
            icon: Rows2,
            run: close(() => onDensityChange('comfortable')),
          },
        ],
      },
      {
        value: 'Help',
        items: [
          {
            value: 'Search all recorded content',
            label: 'Search all recorded content',
            shortcut: '/',
            icon: Search,
            run: close(() => navigate(globalSearchTarget(''))),
          },
          {
            value: 'Keyboard shortcuts',
            label: 'Keyboard shortcuts',
            shortcut: '?',
            icon: CircleHelp,
            run: close(onShortcutHelp),
          },
        ],
      },
    ]
  }, [
    counts,
    density,
    mutating,
    navigate,
    onClearRequest,
    onDensityChange,
    onOpenChange,
    onShortcutHelp,
    onThemeChange,
    selectedApplication,
    status?.paused,
    theme,
    togglePaused,
  ])

  return (
    <CommandDialog onOpenChange={onOpenChange} open={open}>
      <CommandDialogPopup>
        <Command items={groups}>
          <CommandInput placeholder="Jump to a watcher, or run a command…" />
          <CommandPanel>
            <CommandEmpty>No matching watcher or command.</CommandEmpty>
            <CommandList>
              {(group: PaletteGroup) => (
                <Fragment key={group.value}>
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: PaletteItem) => {
                        const Icon = item.icon
                        return (
                          <CommandItem key={item.value} onClick={item.run} value={item.value}>
                            <Icon aria-hidden="true" />
                            <span className="flex-1 truncate">{item.label}</span>
                            {item.hint && (
                              <span className="num shrink-0 text-micro text-ink-4">{item.hint}</span>
                            )}
                            {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                          </CommandItem>
                        )
                      }}
                    </CommandCollection>
                  </CommandGroup>
                  <CommandSeparator />
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-2">
                <KbdGroup>
                  <Kbd>
                    <ArrowUp />
                  </Kbd>
                  <Kbd>
                    <ArrowDown />
                  </Kbd>
                </KbdGroup>
                <span>Navigate</span>
              </span>
              <span className="flex items-center gap-2">
                <Kbd>
                  <CornerDownLeft />
                </Kbd>
                <span>Open</span>
              </span>
            </div>
            <span className="flex items-center gap-2">
              <Kbd>Esc</Kbd>
              <span>Close</span>
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  )
}
