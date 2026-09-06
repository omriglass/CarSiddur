import { z } from "zod";

export const rideTypeSchema = z.object({
  name_he: z.string().trim().min(1),
  code: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z][a-zA-Z0-9_]*$/, "code"),
  sort_order: z.number().int().min(0),
  is_active: z.boolean(),
});
export type RideTypeFormValues = z.infer<typeof rideTypeSchema>;
