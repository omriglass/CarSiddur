import { z } from "zod";

import { he } from "@/i18n/he";
import { CAR_ISSUE_CATEGORIES, carIssueCategorySchema, TIRE_STATES, tireStateSchema } from "@/lib/enums";

import type { CarIssueCategory, TireState } from "@/lib/enums";

/**
 * = SQL `car_issue_category` (DATA_MODEL.md §3.2, REQUIREMENTS §6.6); value
 * list/type live in `src/lib/enums.ts`, re-exported here so existing
 * importers keep working. `Record<CarIssueCategory, string>` labels live at
 * `he.carCare.category` so a value missing its Hebrew label fails
 * `npm run typecheck`.
 */
export { CAR_ISSUE_CATEGORIES };
export type { CarIssueCategory };

/**
 * `category` is `.optional()` at the zod-type level only so the radio group
 * can start unselected (mirrors `features/requests/schema.ts`'s
 * `oneWayCarMode: z.enum(ONE_WAY_CAR_MODES).optional()` for the same
 * "required, but no sensible default" shape); `superRefine` below is what
 * actually makes it required. Callers assert non-null after a successful
 * `form.handleSubmit` (validation already ran).
 */
export const carIssueReportSchema = z
  .object({
    category: carIssueCategorySchema.optional(),
    description: z.string().trim().min(1, he.carCare.descriptionRequired).max(500, he.carCare.descriptionTooLong),
  })
  .superRefine((values, ctx) => {
    if (!values.category) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["category"], message: he.carCare.categoryRequired });
    }
  });
export type CarIssueReportValues = z.infer<typeof carIssueReportSchema>;

/** = SQL `tire_state` (DATA_MODEL.md §3.2, `src/lib/enums.ts`). Green/yellow/red per REQUIREMENTS §13.72. */
export { TIRE_STATES };
export type { TireState };

/** The five tire positions every `log_car_care('tire_fill', …)` call must report. */
export const TIRE_POSITIONS = ["front_left", "front_right", "rear_left", "rear_right", "spare"] as const;
export type TirePosition = (typeof TIRE_POSITIONS)[number];

export type TireStates = Record<TirePosition, TireState>;

export const DEFAULT_TIRE_STATES: TireStates = {
  front_left: "ok",
  front_right: "ok",
  rear_left: "ok",
  rear_right: "ok",
  spare: "ok",
};

/** ok → low → very_low → ok (tap-to-cycle, `TireFillPanel`). */
export function cycleTireState(state: TireState): TireState {
  if (state === "ok") return "low";
  if (state === "low") return "very_low";
  return "ok";
}

export const tireFillSchema = z.object({
  tires: z.object({
    front_left: tireStateSchema,
    front_right: tireStateSchema,
    rear_left: tireStateSchema,
    rear_right: tireStateSchema,
    spare: tireStateSchema,
  }),
  note: z.string().trim().max(300).optional(),
});
export type TireFillValues = z.infer<typeof tireFillSchema>;
