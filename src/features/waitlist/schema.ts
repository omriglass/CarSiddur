import { z } from "zod";

import { waitlistGroupStatusSchema } from "@/lib/enums";

/**
 * `v_waitlist_groups.members` jsonb element (DATA_MODEL.md §7.4a): one
 * participant's denormalized request snapshot. `chosen` is `null` while the
 * group is still `open`.
 */
export const waitlistGroupMemberSchema = z.object({
  request_id: z.string(),
  profile_id: z.string(),
  name: z.string(),
  depart_at: z.string(),
  return_at: z.string(),
  adults: z.number(),
  child_seats: z.number(),
  boosters: z.number(),
  destination: z.string(),
  /** R2Q1 c: the member's own origin when not the department home; absent until the view exposes it. */
  origin_name: z.string().nullish(),
  /** REQ §13.157: who rides with them (companions, then children), for the sheet's one-line summary. */
  companions: z.array(z.string()).default([]),
  chosen: z.boolean().nullable(),
});

/** `v_waitlist_groups` row (REQ §13.75). */
export const waitlistGroupRowSchema = z.object({
  id: z.string(),
  department_id: z.string(),
  week_start: z.string(),
  day: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  status: waitlistGroupStatusSchema,
  ride_id: z.string().nullable(),
  resolved_by: z.string().nullable(),
  resolved_at: z.string().nullable(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  members: z.array(waitlistGroupMemberSchema),
});

/** `waitlist_group_holds()` row (REQ §13.157): a car an open group holds and the car's free gap around it. */
export const waitlistGroupHoldSchema = z.object({
  group_id: z.string(),
  car_id: z.string(),
  held_from: z.string(),
  held_until: z.string(),
  gap_from: z.string(),
  gap_until: z.string(),
});
