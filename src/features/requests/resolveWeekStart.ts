import { dateKey, weekStartFor } from "@/lib/time";

const earliest = <T extends { week_start: string }>(candidates: readonly T[]): T | undefined =>
  candidates.slice().sort((a, b) => a.week_start.localeCompare(b.week_start))[0];

/**
 * Resolve the week a non-specific "new request" entry should target (REQUIREMENTS §13.74).
 *
 * Order of preference:
 * 1. The **open** submission window (earliest `week_start` in phase `open`), wherever it falls.
 * 2. Otherwise the **next** week: the earliest week with `week_start` after today, in phase
 *    `solving` or `published` (a late-request path once the current week has moved past `open`).
 * 3. Only when no such next week exists, **this** week: `live`, or a `solving`/`published` week
 *    whose `week_start` equals today's (the Saturday just before it goes live).
 *
 * An explicit `weekOverride` wins outright as long as it is still eligible (not archived/upcoming
 * and not in the past).
 */
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

  const open = earliest(eligible.filter((week) => week.phase === "open"));
  if (open) return open.week_start;

  const next = earliest(
    eligible.filter((week) => week.week_start > current && (week.phase === "solving" || week.phase === "published")),
  );
  if (next) return next.week_start;

  const currentWeek = earliest(
    eligible.filter(
      (week) => week.week_start === current
        && (week.phase === "live" || week.phase === "solving" || week.phase === "published"),
    ),
  );
  return currentWeek?.week_start;
}
