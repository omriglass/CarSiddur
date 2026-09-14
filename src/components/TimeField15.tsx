import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useContext, useState } from "react";

import { Input } from "@/components/ui/input";
import { SheetPortalContext } from "@/components/SheetPortalContext";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";
import { MAX_MINUTES, MIN_MINUTES, pad2, parseHHMM, snapToQuarterHour } from "./timeField15Format";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

const QUARTER_HOURS = [0, 15, 30, 45] as const;

interface TimeField15Props {
  /** `"HH:MM"`, already on the 15-minute grid. */
  value: string;
  /** `"HH:MM"`, defaults to 06:00. */
  min?: string;
  /** `"HH:MM"`, defaults to 23:45. */
  max?: string;
  onChange: (value: string) => void;
  "aria-label"?: string;
  disabled?: boolean;
  /** react-hook-form field name, for `useScrollToFirstError` to find this control on an invalid submit — forwarded onto the underlying `Input` via `...rest`. */
  "data-field"?: string;
}

/**
 * Two-column 15-minute time picker (UX_FLOWS.md §3.4, component inventory
 * `TimeField15`): a typed `HH:MM` input that snaps on blur, plus a popover
 * with a minutes column (00/15/30/45) on the RTL starting edge and an hours
 * column (05–23) beside it.
 */
export function TimeField15({ value, min, max, onChange, disabled, ...rest }: TimeField15Props) {
  const [draft, setDraft] = useState(value);
  // Re-sync the draft when `value` changes from outside (not from this
  // field's own `commit`) without a `useEffect` — adjusting state during
  // render for a prop change is the pattern React recommends instead
  // (react-hooks' set-state-in-effect rule flags the useEffect form).
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setDraft(value);
  }

  const minMinutes = min ? (parseHHMM(min) ?? undefined) : undefined;
  const maxMinutes = max ? (parseHHMM(max) ?? undefined) : undefined;
  const bounds = { min: minMinutes, max: maxMinutes };

  function commit(next: string) {
    const snapped = snapToQuarterHour(next, bounds);
    if (snapped) {
      setDraft(snapped);
      onChange(snapped);
    } else {
      setDraft(value);
    }
  }

  const [draftHour, draftMinute] = draft.split(":");
  const lowHour = Math.floor((bounds.min ?? MIN_MINUTES) / 60);
  const highHour = Math.floor((bounds.max ?? MAX_MINUTES) / 60);
  const hours = Array.from({ length: highHour - lowHour + 1 }, (_, i) => lowHour + i);
  const portalContainer = useContext(SheetPortalContext);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Input
          {...rest}
          type="text"
          value={draft}
          dir="ltr"
          inputMode="numeric"
          disabled={disabled}
          className="w-24 text-center tabular-nums"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
        />
      </PopoverTrigger>
      <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-56 rounded-md border bg-popover p-2 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          )}
        >
          <div className="grid grid-cols-2 gap-2" dir="rtl">
            <div role="listbox" aria-label={he.timeField.minuteListLabel}>
              {[...QUARTER_HOURS, ...(draftHour === "23" && maxMinutes === 1439 ? [59] : [])].map((m) => (
                <button
                  key={m}
                  type="button"
                  className={cn(
                    "flex h-11 w-full min-w-11 items-center justify-center rounded text-sm hover:bg-accent",
                    draftMinute === pad2(m) && "bg-accent font-semibold",
                  )}
                  onClick={() => commit(`${draftHour ?? "08"}:${pad2(m)}`)}
                >
                  {pad2(m)}
                </button>
              ))}
            </div>
            <div className="max-h-48 overflow-y-auto" role="listbox" aria-label={he.timeField.hourListLabel}>
              {hours.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={cn(
                    "flex h-11 w-full min-w-11 items-center justify-center rounded text-sm hover:bg-accent",
                    draftHour === pad2(h) && "bg-accent font-semibold",
                  )}
                  onClick={() => commit(`${pad2(h)}:${draftMinute ?? "00"}`)}
                >
                  {pad2(h)}
                </button>
              ))}
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </Popover>
  );
}
