import type { ReactNode } from 'react'

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
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="w-full sm:max-w-2xl" side="right">
        <SheetHeader className="gap-2">
          <div className="min-w-0 pe-10">
            <SheetTitle className="break-words">{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </div>
          {meta && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
        </SheetHeader>
        <SheetPanel className="space-y-5">{children}</SheetPanel>
      </SheetPopup>
    </Sheet>
  )
}
