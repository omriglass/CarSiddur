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
  board_start_time: z.string(),
});
export type DepartmentSettingsFormValues = z.infer<typeof departmentSettingsSchema>;
