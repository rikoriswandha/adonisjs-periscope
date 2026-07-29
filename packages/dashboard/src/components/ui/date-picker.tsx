"use client";

import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { useState } from "react";
import type { Matcher } from "@daypicker/react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type DatePickerProps = {
  "aria-label"?: string;
  className?: string;
  disabled?: Matcher | Matcher[];
  id?: string;
  onChange: (date: Date | undefined) => void;
  placeholder?: string;
  value?: Date;
};

export function DatePicker({
  "aria-label": ariaLabel,
  className,
  disabled,
  id,
  onChange,
  placeholder = "Pick a date",
  value,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label={ariaLabel}
        id={id}
        render={
          <Button
            className={cn(
              "w-[10.5rem] justify-start font-normal text-foreground",
              !value && "text-muted-foreground",
              className,
            )}
            size="sm"
            variant="outline"
          />
        }
      >
        <CalendarIcon aria-hidden="true" />
        {value ? format(value, "LLL dd, y") : <span>{placeholder}</span>}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-auto">
        <Calendar
          defaultMonth={value}
          disabled={disabled}
          mode="single"
          onSelect={(date) => {
            onChange(date);
            setOpen(false);
          }}
          selected={value}
        />
      </PopoverPopup>
    </Popover>
  );
}
