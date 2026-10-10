import { z } from "zod";

/** `departments` row form (name, slug, home destination, active). */
export const departmentSchema = z.object({
  name: z.string().trim().min(1),
  slug: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "slug"),
  home_destination_id: z.string().uuid().nullable(),
  is_active: z.boolean(),
});
export type DepartmentFormValues = z.infer<typeof departmentSchema>;

/** `department_settings` row form (weekly-cycle defaults, UX_FLOWS.md §5.1/§5.10). */
export const departmentSettingsSchema = z.object({
  open_dow: z.number().int().min(0).max(6),
  open_time: z.string(),
  close_dow: z.number().int().min(0).max(6),
  close_time: z.string(),
  publish_dow: z.number().int().min(0).max(6),
  publish_time: z.string(),
  turnaround_minutes: z.number().int().min(0).max(120).multipleOf(15),
  day_end_time: z.string(),
  chauffeur_dwell_minutes: z.number().int().min(0),
  detour_limit_minutes: z.number().int().min(0),
  detour_limit_km: z.number().min(0),
  closing_reminder_hours: z.array(z.number().int().min(0)),
  auto_apply_accepted_proposals: z.boolean(),
  /** REQ §13.123: proposals on unpublished days are agreed on WhatsApp, never sent from the app. */
  proposals_offline: z.boolean(),
  board_start_time: z.string(),
  join_radius_km: z.number().min(0).max(100),
  /** REQUIREMENTS §13.93 "Multi-stop rides": dwell time per declared stop (`request_leg_route_minutes()`/`legRouteMinutes()`), default 5. */
  stop_minutes: z.number().int().min(0).max(60),
  /** REQUIREMENTS §13.113: rush-hour windows (Sunday-Thursday) and the extra drive percentage inside each. */
  rush_morning_start: z.string(),
  rush_morning_end: z.string(),
  rush_morning_percent: z.number().int().min(0).max(100),
  rush_afternoon_start: z.string(),
  rush_afternoon_end: z.string(),
  rush_afternoon_percent: z.number().int().min(0).max(100),
}).superRefine((v, ctx) => {
  const m = (t: string) => t.slice(0, 5);
  if (m(v.rush_morning_start) >= m(v.rush_morning_end)) ctx.addIssue({ code: "custom", path: ["rush_morning_end"], message: "rushWindow" });
  if (m(v.rush_afternoon_start) >= m(v.rush_afternoon_end)) ctx.addIssue({ code: "custom", path: ["rush_afternoon_end"], message: "rushWindow" });
  if (m(v.rush_morning_end) > m(v.rush_afternoon_start)) ctx.addIssue({ code: "custom", path: ["rush_afternoon_start"], message: "rushOrder" });
});
export type DepartmentSettingsFormValues = z.infer<typeof departmentSettingsSchema>;
