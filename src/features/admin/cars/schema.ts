import { z } from "zod";

import { he } from "@/i18n/he";

export const CAR_FEATURES = ["roof_rack", "large_trunk", "automatic", "awd"] as const;
export type CarFeature = (typeof CAR_FEATURES)[number];

export const carSchema = z.object({
  name: z.string().trim().min(1),
  license_plate: z.string().trim().min(1),
  access_code: z.string().regex(/^[0-9]{4,5}$/, he.adminCars.codeDigitsRequired),
  is_replaced: z.boolean(),
  replacement_code: z.string().nullable(),
  department_id: z.string().uuid(),
  // No `type` field: the admin form only ever creates/edits shared cars
  // (owner decision 2026-09-10) — `createCar` always sends `type: "shared"`;
  // a temporary car (member-owned, `cars_temporary_owner_ck`) keeps whatever
  // type it already has because this form never submits the column at all.
  status: z.enum(["active", "maintenance", "retired"]),
  features: z.array(z.string()),
  notes: z.string().trim().nullable(),
  built_in_child_seats: z.number().int().min(0),
  built_in_boosters: z.number().int().min(0),
  /** Admin-set, optional (REQ §6.6/§13.69); read-only to a non-admin responsible person (`CarForm`'s `canEditResponsible`). */
  responsible_id: z.string().uuid().nullable(),
}).superRefine((values, ctx) => {
  if (!values.is_replaced) return;
  if (!values.replacement_code || !/^[0-9]{4,5}$/.test(values.replacement_code)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["replacement_code"], message: he.adminCars.codeDigitsRequired });
  } else if (values.replacement_code === values.access_code) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["replacement_code"], message: he.adminCars.replacementCodeDifferent });
  }
});
export type CarFormValues = z.infer<typeof carSchema>;
