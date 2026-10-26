import type { Database } from "@/integrations/supabase/types";

type RequestRow = Database["public"]["Tables"]["requests"]["Row"];

/** A `requests` row as a browser may read it: every column but `notes` (REQ §13.153, closed by grants). */
export type ReadableRequestRow = Omit<RequestRow, "notes">;

/**
 * Use instead of `select("*")` on `requests`: `*` names `notes`, which `authenticated` may not read, so the whole query
 * would fail. A literal string so the typed `select` still infers the row; the note itself comes from
 * `request_notes(ids)` (requests the caller may edit). Mirrors the column grants in `20261028210000` and `20261029100500`.
 */
// One literal on purpose (a concatenation would be typed `string`).
// prettier-ignore
export const REQUEST_COLUMNS = "id, department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id, trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination, adults, child_seats, boosters, has_luggage, flex_depart_early, flex_depart_late, flex_return_early, flex_return_late, is_late, submitted_at, status, status_reason, changed_since_solve, freed_slot_opt_out, manual_boost, manual_boost_reason, join_ride_id, template_id, version, created_at, updated_at, preferred_car_id, original_depart_at, original_return_at, ride_description, guest_passenger_names, series_id, series_index, series_count, origin_id, origin_text, trip_type, kept_return_at, depart_anchor, arrive_by, return_anchor, leave_dest_at, luggage_waived_at, luggage_waived_by, duration_locked, fallback, served_by_alternative, plan_b_parent_id, keep_car_at_destination, reserved_at";

type Split<S extends string, Acc extends string = never> = S extends `${infer Head}, ${infer Tail}` ? Split<Tail, Acc | Head> : Acc | S;
type Listed = Split<typeof REQUEST_COLUMNS>;
/** Fails to compile when `requests` gains a column this list (and the SQL column grant) does not name, or lists a wrong one. */
const allColumnsListed: [Exclude<keyof ReadableRequestRow, Listed>, Exclude<Listed, keyof ReadableRequestRow>] extends [never, never] ? true : false = true;
void allColumnsListed;
