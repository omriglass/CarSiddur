import { z } from "zod";

export const CAR_FEATURES = ["roof_rack", "large_trunk", "automatic", "awd"] as const;
export type CarFeature = (typeof CAR_FEATURES)[number];

export const carSchema = z.object({
  name: z.string().trim().min(1),
  license_plate: z.string().trim().min(1),
  department_id: z.string().uuid(),
  type: z.enum(["shared", "temporary"]),
  status: z.enum(["active", "maintenance", "retired"]),
  features: z.array(z.string()),
  notes: z.string().trim().nullable(),
  built_in_child_seats: z.number().int().min(0),
  built_in_boosters: z.number().int().min(0),
});
export type CarFormValues = z.infer<typeof carSchema>;

export const maintenanceBlockSchema = z.object({
  carId: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  reason: z.string().trim().min(1),
});
export type MaintenanceBlockFormValues = z.infer<typeof maintenanceBlockSchema>;
