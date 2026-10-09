import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useCallback, useContext, useState } from "react";

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
 * column (06–23) beside it.
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

  const [inlineOpen, setInlineOpen] = useState(false);

  // R3B19: the list opens on the current hour. A STABLE callback ref, so it runs on mount only — an inline ref re-ran on every
  // re-render (the input's blur-commit just before a tap re-renders the form) and snapped the list back to the selected hour
  // between pointer-down and pointer-up, so the tapped hour moved away and the pick was lost.
  const scrollToSelectedHour = useCallback((list: HTMLDivElement | null) => {
    const selected = list?.querySelector<HTMLElement>("[data-selected='true']");
    if (list && selected) list.scrollTop = Math.max(0, selected.offsetTop - 44);
  }, []);

  // R11U10: inside a sheet the list is shorter (four and a half rows), so the rows below it stay clear of the sticky footer on a 360px phone.
  const picker = (inline: boolean) => (
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
  {/* R10U6: six and a half rows high (the half row hints at the scroll) with a thin always-visible scrollbar and a fade at the foot, so it reads as scrollable. */}
  <div className={cn("relative overflow-y-auto [scrollbar-color:hsl(var(--muted-foreground)/0.6)_transparent] [scrollbar-width:thin]", inline ? "max-h-[12.25rem]" : "max-h-72")} role="listbox" aria-label={he.timeField.hourListLabel} data-testid="time-hour-list" ref={scrollToSelectedHour}>
    {hours.map((h) => (
      <button
        key={h}
        type="button"
        data-selected={draftHour === pad2(h)}
        className={cn(
          "flex h-11 w-full min-w-11 items-center justify-center rounded text-sm hover:bg-accent",
          draftHour === pad2(h) && "bg-accent font-semibold",
        )}
        onClick={() => commit(`${pad2(h)}:${draftMinute ?? "00"}`)}
      >
        {pad2(h)}
      </button>
    ))}
    <div aria-hidden="true" className="pointer-events-none sticky bottom-0 -mt-6 h-6 bg-gradient-to-t from-popover to-transparent" />
  </div>
</div>
  );

  // Inside a sheet/dialog the lists open inline under the input (pushing content down; the sheet's own scroll
  // handles the rest) instead of a popover that the sheet would clip. Outside one, the popover stays.
  if (portalContainer) {
    return (
      <div
        className="space-y-1"
        onBlur={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setInlineOpen(false);
        }}
      >
        <Input
          {...rest}
          type="text"
          value={draft}
          dir="ltr"
          inputMode="numeric"
          disabled={disabled}
          aria-expanded={inlineOpen}
          aria-haspopup="dialog"
          className="w-24 text-center tabular-nums"
          onClick={() => setInlineOpen((open) => !open)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
        />
        {inlineOpen ? (
          <div className="mx-auto w-56 max-w-full rounded-md border bg-popover p-2 text-popover-foreground" data-testid="time-inline-picker">
            {picker(true)}
          </div>
        ) : null}
      </div>
    );
  }

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
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          // R10U6: centred under the input, never closer than 8px to the screen edge (360px phones).
          align="center"
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            "z-50 w-56 max-w-[calc(100vw-1rem)] rounded-md border bg-popover p-2 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          )}
        >
          {picker(false)}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </Popover>
  );
}
