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
