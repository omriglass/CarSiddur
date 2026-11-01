import { z } from "zod";

import { rideTypeColorSchema } from "@/lib/enums";

export const rideTypeSchema = z.object({
  name_he: z.string().trim().min(1),
  code: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z][a-zA-Z0-9_]*$/, "code"),
  sort_order: z.number().int().min(0),
  is_active: z.boolean(),
  /** REQ §13.177 (b): the colour of this type's rides on the siddur and board. */
  color: rideTypeColorSchema,
});
export type RideTypeFormValues = z.infer<typeof rideTypeSchema>;
