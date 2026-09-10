import { dateKey, weekStartFor } from "@/lib/time";

/** Prefer the open submission window, but retain a late-request path while solving. */
export function resolveWeekStart(
  weeks: readonly { week_start: string; phase: string }[],
  weekOverride: string | undefined,
  now = new Date(),
): string | undefined {
  const current = dateKey(weekStartFor(now));
  const eligible = weeks.filter(
    (week) => week.week_start >= current && week.phase !== "archived" && week.phase !== "upcoming",
  );
  if (weekOverride && eligible.some((week) => week.week_start === weekOverride)) return weekOverride;
  for (const phase of ["open", "live", "solving", "published"]) {
    const first = eligible.filter((week) => week.phase === phase)
      .sort((a, b) => a.week_start.localeCompare(b.week_start))[0];
    if (first) return first.week_start;
  }
  return undefined;
}
