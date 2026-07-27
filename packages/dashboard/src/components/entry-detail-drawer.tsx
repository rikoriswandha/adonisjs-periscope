import { useEffect, useState, type ReactNode } from 'react'

import { EntryTagChips } from '@/components/tag-chip'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from '@/components/ui/sheet'

export function EntryDetailDrawer({
  open,
  onOpenChange,
  title,
  description,
  meta,
  tags,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  meta?: ReactNode
  tags?: readonly string[]
  children: ReactNode
}) {
  // Start closed on mount so Base UI can play the enter transition even when
  // the drawer is first rendered with open=true (registered entry details).
  const [present, setPresent] = useState(false)

  useEffect(() => {
    if (!open) {
      setPresent(false)
      return
    }

    const frame = requestAnimationFrame(() => setPresent(true))
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <Sheet onOpenChange={onOpenChange} open={present}>
      <SheetPopup className="w-full sm:max-w-2xl" side="right">
        <SheetHeader className="gap-2.5 p-4 sm:p-5">
          <div className="min-w-0 pe-10">
            <SheetTitle className="break-words font-mono text-base leading-snug">{title}</SheetTitle>
            <SheetDescription className="mt-1 text-xs leading-5">{description}</SheetDescription>
          </div>
          {meta && <div className="flex flex-wrap items-center gap-1.5">{meta}</div>}
        </SheetHeader>
        <Separator />
        <SheetPanel className="space-y-4 p-4 sm:p-5">
          {tags && <EntryTagChips tags={tags} />}
          {children}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  )
}
