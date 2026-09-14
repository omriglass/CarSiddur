/**
 * Three/four-state "בקשה חדשה" button (docs/TODO.md F2, owner decision 2026-09-14,
 * revised same day: the button must always read as being about *next* week — REQUIREMENTS
 * §13.81; UX_FLOWS.md relevant screen sections).
 *
 * Reuses the same `weeks` rows every other "which week is next" decision reads (e.g.
 * `resolveWeekStart.ts`) instead of inventing a second source of truth — this module only
 * adds the *label/enabled* mapping on top.
 *
 * "target week" = the newest non-archived week that is not `live` (the next week), falling
 * back to the `live` week when nothing newer exists. A target whose phase is `upcoming`
 * (materialized early only for a multi-day series leg, REQ §13.77 — invisible to ordinary
 * members) is not really "next" yet, so it is excluded and the live week is used instead,
 * same as having no next week at all.
 */

export interface NewRequestButtonWeek {
  week_start: string;
  phase: string;
}

export type NewRequestButtonState =
  | { kind: "nextWeek"; weekStart: string }
  | { kind: "preparing" }
  | { kind: "waitlistNextWeek"; weekStart: string }
  | { kind: "nextWeekNotOpenYet" };

function latest(weeks: readonly NewRequestButtonWeek[]): NewRequestButtonWeek | undefined {
  return weeks.slice().sort((a, b) => b.week_start.localeCompare(a.week_start))[0];
}

export function newRequestButtonState(weeks: readonly NewRequestButtonWeek[]): NewRequestButtonState {
  const nonArchived = weeks.filter((week) => week.phase !== "archived");
  const nextCandidate = latest(nonArchived.filter((week) => week.phase !== "live" && week.phase !== "upcoming"));

  if (nextCandidate) {
    if (nextCandidate.phase === "open") return { kind: "nextWeek", weekStart: nextCandidate.week_start };
    if (nextCandidate.phase === "solving") return { kind: "preparing" };
    if (nextCandidate.phase === "published") return { kind: "waitlistNextWeek", weekStart: nextCandidate.week_start };
  }

  const live = latest(nonArchived.filter((week) => week.phase === "live"));
  if (live) {
    // Only the live week exists and nothing newer is open yet: the button still always talks
    // about *next* week (never "this week"), it's just not open to request against yet —
    // disabled, same treatment as `preparing`.
    return { kind: "nextWeekNotOpenYet" };
  }

  // No usable week at all yet (e.g. still loading) — nothing to link to.
  return { kind: "preparing" };
}
