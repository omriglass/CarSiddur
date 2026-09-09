import { rpc } from "@/lib/rpc";

import type { Json } from "@/integrations/supabase/types";
import type { Database } from "@/integrations/supabase/types";

import type { CarIssueCategory, TireStates } from "./schema";

/**
 * The only file in the `carCare` feature that calls `supabase.rpc()`
 * (CLAUDE.md Conventions "Data"). Both RPCs are `SECURITY DEFINER` — the
 * responsible-person/admin fallback for the resulting notification
 * (`car_care_recipients()`, REQUIREMENTS §6.6 / §13.70) is resolved
 * server-side, so the client only ever needs the car id.
 */
export type CarCareKind = Database["public"]["Enums"]["car_care_kind"];

/**
 * `report_car_issue(_car_id, _category, _description, _photo_path?)`.
 * `photoPath` is accepted for forward compatibility with the RPC signature
 * but never sent today: no storage bucket / upload UI exists yet anywhere
 * in the app for `car_issues.photo_path` (grepped `admin/cars`, `fleet`,
 * `storage.from` — none found). Reported to the caller so the "optional
 * photo" part of REQUIREMENTS §6.6 is a documented gap, not a silent one.
 */
export async function reportCarIssue(input: {
  carId: string;
  category: CarIssueCategory;
  description: string;
}): Promise<string> {
  return rpc("report_car_issue", {
    _car_id: input.carId,
    _category: input.category,
    _description: input.description,
  });
}

/** `log_car_care(_car_id, _kind, _tires?, _note?)`. `tires` is required for `tire_fill`, omitted for `wash`. */
export async function logCarCare(input: {
  carId: string;
  kind: CarCareKind;
  tires?: TireStates;
  note?: string;
}): Promise<string> {
  return rpc("log_car_care", {
    _car_id: input.carId,
    _kind: input.kind,
    _tires: input.tires as unknown as Json,
    _note: input.note,
  });
}
