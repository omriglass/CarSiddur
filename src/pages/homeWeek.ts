import { formatInTimeZone } from "date-fns-tz";

import { TZ } from "@/lib/time";

import type { Database } from "@/integrations/supabase/types";

type HomeWeekPreference = Database["public"]["Enums"]["home_week_preference"];
type WeekPhase = Database["public"]["Enums"]["week_phase"];

export interface WeekPhaseRow {
  weekStart: string;
  phase: WeekPhase;
}

/**
 * Resolves which week `/my` opens on (REQUIREMENTS §5.5, UX_FLOWS.md §3.3):
 * `auto` = the Live week if I have a ride today or tomorrow, else the next
 * Open week; `live`; `open`. Falls back to whichever of the two exists when
 * the preferred one doesn't (e.g. no week is currently `live`).
 */
export function resolveHomeWeek(
  preference: HomeWeekPreference,
  weeks: readonly WeekPhaseRow[],
  hasRideTodayOrTomorrow: boolean,
): WeekPhaseRow | undefined {
  const live = weeks.find((w) => w.phase === "live");
  const open = weeks.find((w) => w.phase === "open");

  if (preference === "live") return live ?? open;
  if (preference === "open") return open ?? live;
  // auto
  if (hasRideTodayOrTomorrow && live) return live;
  return open ?? live;
}

/**
 * Whether any of `startsAtList` (ISO instants) falls on today or tomorrow in
 * Asia/Jerusalem wall-clock time (hard rule 6: never a raw UTC date slice).
 * `now` is injectable for tests; defaults to the real clock.
 */
export function hasRideTodayOrTomorrow(startsAtList: readonly string[], now: Date = new Date()): boolean {
  const todayYmd = formatInTimeZone(now, TZ, "yyyy-MM-dd");
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowYmd = formatInTimeZone(tomorrow, TZ, "yyyy-MM-dd");
  return startsAtList.some((iso) => {
    const ymd = formatInTimeZone(new Date(iso), TZ, "yyyy-MM-dd");
    return ymd === todayYmd || ymd === tomorrowYmd;
  });
}
