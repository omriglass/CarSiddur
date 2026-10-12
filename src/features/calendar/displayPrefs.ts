// Which fields of a calendar event show on its faint block, per device (owner 2026-10-12). The title is always shown.
import { clampItemVisibility, ITEM_VISIBILITY_DEFAULT } from "@/components/itemVisibility";

const STORAGE_KEY = "calendar.display.v1";

export interface CalendarDisplayPrefs {
  hours: boolean;
  location: boolean;
  participants: boolean;
  notes: boolean;
  /** Tint blocks with the calendar's / event's own color instead of the app's sky tint. */
  useCalendarColors: boolean;
  /**
   * "Visibility aid" (owner 2026-10-12): 0–100, 50 = the normal look; lower fades my rides / requests over the
   * calendar, higher makes the see-through ones solid (`src/components/itemVisibility.ts`).
   */
  itemVisibility: number;
}

export const DEFAULT_DISPLAY_PREFS: CalendarDisplayPrefs = { hours: true, location: true, participants: false, notes: false, useCalendarColors: false, itemVisibility: ITEM_VISIBILITY_DEFAULT };

export function readDisplayPrefs(): CalendarDisplayPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DISPLAY_PREFS;
    const parsed = JSON.parse(raw) as Partial<CalendarDisplayPrefs>;
    type BooleanKey = Exclude<keyof CalendarDisplayPrefs, "itemVisibility">;
    const pick = (key: BooleanKey): boolean => (typeof parsed[key] === "boolean" ? (parsed[key] as boolean) : DEFAULT_DISPLAY_PREFS[key]);
    return { hours: pick("hours"), location: pick("location"), participants: pick("participants"), notes: pick("notes"), useCalendarColors: pick("useCalendarColors"), itemVisibility: clampItemVisibility(parsed.itemVisibility) };
  } catch {
    // Private browsing / garbage: the defaults are a safe fallback.
    return DEFAULT_DISPLAY_PREFS;
  }
}

export function writeDisplayPrefs(prefs: CalendarDisplayPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A convenience only; storage may be denied.
  }
}
