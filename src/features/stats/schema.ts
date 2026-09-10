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

/** `department_stats` jsonb return shape, validated at the `stats/api.ts` boundary before it reaches the UI. */
export const departmentStatsSchema = z.object({
  from: z.string(),
  to: z.string(),
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
  }),
  rides: z.number(),
  byWeekday: z.array(weekdayStatSchema).length(7),
  // `average` ignores zero-score weeks (per the RPC's own definition); nullable to cover the
  // "no week published in range" case explicitly rather than overloading `0` as "no data".
  policyScore: z.object({
    average: z.number().nullable(),
    weeks: z.number(),
  }),
});
