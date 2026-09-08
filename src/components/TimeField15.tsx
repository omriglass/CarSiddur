import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const MIN_MINUTES = 6 * 60;
const MAX_MINUTES = 23 * 60 + 45; // 23:45
const QUARTER_HOURS = [0, 15, 30, 45] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parses `"HH:MM"` to minutes since midnight, or `null` if not well-formed. */
export function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

/**
 * Rounds `"HH:MM"` to the nearest 15-minute mark and clamps to `[min, max]`
 * (default 06:00–23:45). End fields may explicitly allow 23:59.
 * Returns `null` for unparsable
 * input so callers can revert instead of committing garbage.
 */
export function snapToQuarterHour(
  value: string,
  bounds: { min?: number; max?: number } = {},
): string | null {
  const parsed = parseHHMM(value);
  if (parsed === null) return null;
  const min = bounds.min ?? MIN_MINUTES;
  const max = bounds.max ?? MAX_MINUTES;
  if (parsed === 1439 && max === 1439) return "23:59";
  const rounded = Math.round(parsed / 15) * 15;
  return formatMinutes(Math.min(Math.max(rounded, min), max));
}

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
      <PopoverContent className="w-56 p-2" align="start">
        <div className="grid grid-cols-2 gap-2" dir="rtl">
          <div role="listbox" aria-label="דקות">
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
          <div className="max-h-48 overflow-y-auto" role="listbox" aria-label="שעה">
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
      </PopoverContent>
    </Popover>
  );
}
