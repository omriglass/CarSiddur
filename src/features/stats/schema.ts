import { z } from "zod";

/**
 * One `byWeekday` entry of the `department_stats(p_department_id, p_from, p_to)`
 * RPC (owner request, UX_FLOWS.md §5.12): `dow` is a bare 0 (Sunday) .. 6
 * (Saturday) index with no associated calendar date (see `dowLabel.ts` for
 * turning it into a Hebrew weekday name).
 */
export const weekdayStatSchema = z.object({
  dow: z.number().int().min(0).max(6),
  occurrences: z.number(),
  avgActiveHours: z.number(),
  avgRides: z.number(),
  utilizationRate: z.number(),
});

/**
 * One `byRideType` entry (owner request, UX_FLOWS.md §5.12 ride-type donut):
 * `rideTypeId` is nullable (legacy rides with no ride type recorded), `name`
 * likewise falls back to `stats.otherRideType` in the UI. Server-ordered by
 * `rides` desc.
 */
export const rideTypeStatSchema = z.object({
  rideTypeId: z.string().nullable(),
  code: z.string(),
  name: z.string().nullable(),
  rides: z.number(),
  hours: z.number(),
});

/**
 * One `weekly` entry (owner request, UX_FLOWS.md §5.12 weekly unmet-requests
 * chart): `weekStart` is a `yyyy-MM-dd` Sunday key; `provisional` marks a
 * week whose data isn't final yet (not `archived`) so the chart can flag it
 * as partial rather than implying a real drop in unmet requests.
 */
export const weeklyStatSchema = z.object({
  weekStart: z.string(),
  total: z.number(),
  granted: z.number(),
  unmet: z.number(),
  cancelled: z.number(),
  rides: z.number(),
  provisional: z.boolean(),
});

/** `department_stats` jsonb return shape, validated at the `stats/api.ts` boundary before it reaches the UI. */
export const departmentStatsSchema = z.object({
  from: z.string(),
  to: z.string(),
  // `yyyy-MM-dd` earliest date with data for the department, or `null` when the RPC can't
  // determine one (e.g. no rows at all); `from`/`to` above are already server-clamped to
  // `[earliest, today]` (owner feedback, UX_FLOWS.md §5.12) — the UI reflects those back,
  // never re-derives them.
  earliest: z.string().nullable().optional(),
  days: z.number(),
  sharedCars: z.number(),
  utilization: z.object({
    activeHours: z.number(),
    capacityHours: z.number(),
    rate: z.number(),
  }),
  requests: z.object({
    total: z.number(),
    granted: z.number(),
    unmet: z.number(),
    cancelled: z.number(),
    unmetRate: z.number(),
    // Optional while the `department_stats` migration adding it is in flight (db-migrator,
    // concurrent work) — the UI falls back to `granted / total` until it's present.
    servedRate: z.number().optional(),
  }),
  rides: z.number(),
  // Distinct members who rode (as driver or passenger) in range — children/guests not counted
  // (UX_FLOWS.md §5.12 people tile). Optional for the same "migration in flight" reason above.
  distinctPeople: z.number().optional(),
  distinctDrivers: z.number().optional(),
  byWeekday: z.array(weekdayStatSchema).length(7),
  // `average` ignores zero-score weeks (per the RPC's own definition); nullable to cover the
  // "no week published in range" case explicitly rather than overloading `0` as "no data".
  policyScore: z.object({
    average: z.number().nullable(),
    weeks: z.number(),
  }),
  // Both optional/nullable-friendly while the RPC migration adding them lands (db-migrator,
  // concurrent work); the screen hides the corresponding section when absent or empty.
  byRideType: z.array(rideTypeStatSchema).optional(),
  weekly: z.array(weeklyStatSchema).optional(),
});
