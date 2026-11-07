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
  /** REQ §13.186 c: the driver, else the first rider, else the first named person (absent from an older server). */
  person_name: z.string().nullable().optional(),
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
export const CAR_SWAP_BLOCKER_CODES = ["seats", "maintenance", "private_car", "not_allowed", "past", "luggage", "series_other_day_busy", "overlap", "swap_too_large", "archived"] as const;
export type CarSwapBlockerCode = (typeof CAR_SWAP_BLOCKER_CODES)[number];
export const carSwapBlockerSchema = z.object({
  code: z.enum(CAR_SWAP_BLOCKER_CODES),
  // `not_allowed` / `past` blockers carry only `detail`; `private_car` has no ride — absent keys are fine.
  ride_id: z.string().nullish(),
  car_id: z.string().nullish(),
  detail: z.string().nullish(),
  /** REQ §13.111 (a): a luggage blocker the Sadran may accept (`swap_day_cars` with `allow_small_trunk`). */
  waivable: z.boolean().optional(),
  request_ids: z.array(z.string()).optional(),
  /** `series_other_day_busy` (REQ §13.92, 2026-10-16): refuses only the "whole" series mode; the "day" mode stays available. */
  whole_only: z.boolean().optional(),
  /** `series_other_day_busy`: the conflicting ride of the target car (`day` = yyyy-MM-dd); `overlap` (REQ §13.180): the ride staying there. */
  day: z.string().optional(),
  starts_at: z.string().optional(),
  ends_at: z.string().optional(),
  /** `swap_too_large` (REQ §13.186): the closed set's size. */
  rides: z.number().optional(),
  days: z.number().optional(),
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
  /** REQ §13.180: rides after the cutoff that stay on their car — the other car has too few seats (asked before the swap). */
  staying: z.array(carSwapRideSchema).optional(),
  series: z.array(carSwapSeriesSchema),
  /** REQ §13.186: rides the "whole" mode also moves — other days' rides of either car pulled in by the chain. */
  chain: z.array(carSwapRideSchema).optional(),
  /** REQ §13.186: the whole closed set (day + series + chain), for "ההחלפה כוללת N נסיעות ב־M ימים". */
  chain_rides: z.number().optional(),
  chain_days: z.number().optional(),
  blockers: z.array(carSwapBlockerSchema),
  notices: z.array(carSwapNoticeSchema),
  can_swap: z.boolean(),
  /** True when a series leg on another day collides with the target car — only "day" mode can go ahead. */
  whole_blocked: z.boolean().optional(),
  /** REQ §13.111 (a): the swap can go ahead, but a large-luggage request would land on a car without a large trunk. */
  needs_small_trunk: z.boolean().optional(),
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
