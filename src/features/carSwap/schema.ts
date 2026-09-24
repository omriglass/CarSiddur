import { z } from "zod";

/**
 * Swap cars on a day by dragging car names (REQ §13.92, owner batch
 * 2026-09-24 S1 A1–A7). `preview_day_car_swap()`/`swap_day_cars()` return
 * plain `jsonb` with no generated row type, so both responses are
 * zod-parsed at the `carSwap/api.ts` boundary before they reach any
 * hook/component — same convention `stats/schema.ts` uses for
 * `department_stats`.
 */

/** One ride that would move from its current car to the other car (before the swap). */
export const carSwapRideSchema = z.object({
  ride_id: z.string(),
  car_id: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  driver_name: z.string().nullable(),
  label: z.string().nullable(),
  series_id: z.string().nullable(),
  series_index: z.number().nullable(),
  series_count: z.number().nullable(),
});
export type CarSwapRide = z.infer<typeof carSwapRideSchema>;

/** One multi-day series that a moved ride is a leg of — the "whole span vs. only this day" question (A1). */
export const carSwapSeriesSchema = z.object({
  series_id: z.string(),
  car_id: z.string(),
  days: z.array(z.string()),
  first_day: z.string(),
  last_day: z.string(),
});
export type CarSwapSeries = z.infer<typeof carSwapSeriesSchema>;

/** A4: refused on `seats`/`maintenance`/`private_car`/`not_allowed`; `past` covers a day already archived-by-time. */
export const CAR_SWAP_BLOCKER_CODES = ["seats", "maintenance", "private_car", "not_allowed", "past"] as const;
export type CarSwapBlockerCode = (typeof CAR_SWAP_BLOCKER_CODES)[number];
export const carSwapBlockerSchema = z.object({
  code: z.enum(CAR_SWAP_BLOCKER_CODES),
  ride_id: z.string().nullable(),
  car_id: z.string().nullable(),
  detail: z.string().nullable(),
});
export type CarSwapBlocker = z.infer<typeof carSwapBlockerSchema>;

/** A4: a car ending the day away from home after the swap is allowed, just flagged. */
export const carSwapNoticeSchema = z.object({
  code: z.literal("ends_away"),
  car_id: z.string(),
  location_id: z.string(),
  location_name: z.string(),
});
export type CarSwapNotice = z.infer<typeof carSwapNoticeSchema>;

export const carSwapPreviewSchema = z.object({
  fingerprint: z.string(),
  rides: z.array(carSwapRideSchema),
  series: z.array(carSwapSeriesSchema),
  blockers: z.array(carSwapBlockerSchema),
  notices: z.array(carSwapNoticeSchema),
  can_swap: z.boolean(),
  notify: z.boolean(),
});
export type CarSwapPreview = z.infer<typeof carSwapPreviewSchema>;

export const carSwapResultSchema = z.object({
  moved_rides: z.number(),
  notified: z.number(),
  notices: z.array(carSwapNoticeSchema),
});
export type CarSwapResult = z.infer<typeof carSwapResultSchema>;

/** A1: "whole" moves every day of a series leg; "day" splits it into up to three series. */
export const CAR_SWAP_SERIES_MODES = ["whole", "day"] as const;
export type CarSwapSeriesMode = (typeof CAR_SWAP_SERIES_MODES)[number];
