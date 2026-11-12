#!/usr/bin/env node
// PF1 DC2b (docs/PF1_PLAN_2026-11.md §12): `week_parts()` must answer exactly what the separate API calls answered.
//
// `compareWeekParts(client, dept, week)` reads one department-week both ways as the signed-in `client` - every part
// through `week_parts`, and the query the browser sent for it before migration 20261112233000 (kept here verbatim) -
// and returns the parts that differ. scripts/test-api.mjs runs it on fixture weeks (CI); standalone it walks every
// member of a local stack:
//   node scripts/qa/week-parts-oracle.mjs --api http://127.0.0.1:60731 --dept <id> --week <date> [--week …]
//        [--password debug-local-1234] [--emails a@x,b@y]      (local stacks only; prints counts, never rows)
import { createClient } from "@supabase/supabase-js";

const REQUEST_COLUMNS = "id, department_id, week_start, requester_id, filed_by, destination_id, destination_text, ride_type_id, trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination, adults, child_seats, boosters, has_luggage, needs_tow_hitch, flex_depart_early, flex_depart_late, flex_return_early, flex_return_late, is_late, submitted_at, status, status_reason, changed_since_solve, freed_slot_opt_out, manual_boost, manual_boost_reason, join_ride_id, template_id, version, created_at, updated_at, preferred_car_id, original_depart_at, original_return_at, ride_description, guest_passenger_names, series_id, series_index, series_count, origin_id, origin_text, trip_type, kept_return_at, depart_anchor, arrive_by, return_anchor, leave_dest_at, luggage_waived_at, luggage_waived_by, duration_locked, fallback, served_by_alternative, plan_b_parent_id, keep_car_at_destination, reserved_at";
const WEEK_REQUEST_SELECT = `${REQUEST_COLUMNS},
  requester:profiles!requests_requester_id_fkey(full_name, does_not_drive),
  filer:profiles!requests_filed_by_fkey(full_name),
  destination:destinations!requests_destination_id_fkey(name, travel_minutes),
  origin:destinations!requests_origin_id_fkey(name),
  ride_type:ride_types(code, name_he),
  preferred_car:cars!requests_preferred_car_id_fkey(name),
  companions:request_companions(profile_id, profile:profiles!request_companions_profile_id_fkey(full_name, does_not_drive)),
  request_children(child:children(full_name)),
  stops:request_stops(leg, position, place_id, place_text, place:destinations(name)),
  alternative:request_alternatives(drop_place_id, drop_place_text, arrive_by, pickup, pickup_at, pickup_place_id, pickup_place_text, applied_at, drop_place:destinations!request_alternatives_place_fk(name), pickup_place:destinations!request_alternatives_pickup_place_fk(name))`;

/** part -> the query the browser sent for it; `ordered` = the order was part of the query. */
const OLD_QUERIES = {
  week: { run: (c, d, w) => c.from("weeks").select("*").eq("department_id", d).eq("week_start", w).maybeSingle() },
  rides: { run: (c, d, w) => c.rpc("week_board_rides", { p_department_id: d, p_week_start: w }) },
  requests: { run: (c, d, w) => c.from("requests").select(WEEK_REQUEST_SELECT).eq("department_id", d).eq("week_start", w) },
  proposals: { ordered: true, run: (c, d, w) => c.from("proposals").select("*").eq("department_id", d).eq("week_start", w).order("created_at", { ascending: false }) },
  freedOffers: {
    ordered: true,
    run: (c, d, w) => c.from("freed_slot_offers")
      .select("*, car:cars!freed_slot_offers_car_id_fkey(name), cancelled_ride:rides!freed_slot_offers_cancelled_ride_id_fkey(starts_at, ends_at)")
      .eq("department_id", d).eq("week_start", w).order("created_at", { ascending: false }),
  },
  heldNotices: { run: (c, d, w) => c.from("held_notices").select("id, day, recipient_id, subject_kind, subject_id").eq("department_id", d).eq("week_start", w) },
  carLocations: { run: (c, d, w) => c.from("v_car_locations").select("*").eq("department_id", d).eq("week_start", w) },
  waitlistGroups: { run: (c, d, w) => c.from("v_waitlist_groups").select("*").eq("department_id", d).eq("week_start", w).eq("status", "open") },
  waitlistHolds: { run: (c, d, w) => c.rpc("waitlist_group_holds", { p_department_id: d, p_week_start: w }) },
  siddurWaitlist: { run: (c, d, w) => c.rpc("siddur_waitlist", { p_department_id: d, p_week_start: w }) },
  rideChanges: {
    ordered: true,
    run: (c, d, w) => c.from("ride_change_requests")
      .select("*, requester:profiles!ride_change_requests_requester_id_fkey(full_name), parties:ride_change_parties(*)")
      .eq("status", "pending").eq("department_id", d).eq("week_start", w).order("created_at"),
  },
};
export const WEEK_PARTS = Object.keys(OLD_QUERIES);

/** Embedded lists whose order the old query never fixed. */
const UNORDERED_KEYS = new Set(["companions", "request_children", "stops", "parties"]);

function canonical(value, key, sortTop) {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item));
    return sortTop || UNORDERED_KEYS.has(key) ? items.map((i) => JSON.stringify(i)).sort().map((s) => JSON.parse(s)) : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k], k)]));
  }
  return value;
}

/**
 * Compares every part. Resolves `{ differ: string[], rows: Record<part, number>, errors: Record<part, string> }`:
 * `differ` names a part whose rows differ, or which failed on one side only / with another error code.
 */
export async function compareWeekParts(client, departmentId, weekStart, parts = WEEK_PARTS) {
  const snapshot = await client.rpc("week_parts", { p_department_id: departmentId, p_week_start: weekStart, p_parts: parts });
  if (snapshot.error) throw new Error(`week_parts: ${snapshot.error.message}`);
  const differ = [];
  const rows = {};
  const errors = {};
  await Promise.all(parts.map(async (part) => {
    const spec = OLD_QUERIES[part];
    const old = await spec.run(client, departmentId, weekStart);
    const now = snapshot.data?.[part];
    if (old.error || now?.error) {
      errors[part] = `${old.error?.code ?? "ok"} / ${now?.error?.code ?? "ok"}`;
      if (old.error?.code !== now?.error?.code || old.error?.message !== now?.error?.message) differ.push(part);
      return;
    }
    const a = JSON.stringify(canonical(old.data ?? null, part, !spec.ordered));
    const b = JSON.stringify(canonical(now?.data ?? null, part, !spec.ordered));
    rows[part] = Array.isArray(old.data) ? old.data.length : old.data ? 1 : 0;
    if (a !== b) differ.push(part);
  }));
  return { differ, rows, errors };
}

// ------------------------------------------------------------------------------------------------- standalone
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const all = (name) => process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1]] : []));
  const api = all("api")[0];
  const dept = all("dept")[0];
  const weeks = all("week");
  const password = all("password")[0] ?? "debug-local-1234";
  if (!api || !dept || weeks.length === 0) {
    console.error("usage: week-parts-oracle.mjs --api <local api> --dept <id> --week <date> [--week …] [--password …] [--emails a,b]");
    process.exit(1);
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(api)) {
    console.error("week-parts-oracle: local stacks only");
    process.exit(1);
  }
  const { LOCAL_ANON_KEY, LOCAL_SERVICE_KEY } = await import("./qa-common.mjs");
  const svc = createClient(api, LOCAL_SERVICE_KEY, { auth: { persistSession: false } });
  let emails = all("emails")[0]?.split(",");
  if (!emails) {
    const { data, error } = await svc.auth.admin.listUsers({ perPage: 1000 });
    if (error) throw error;
    emails = data.users.map((u) => u.email).filter(Boolean).sort();
  }
  let pairs = 0;
  let totalRows = 0;
  let bad = 0;
  let skipped = 0;
  for (const email of emails) {
    const client = createClient(api, LOCAL_ANON_KEY, { auth: { persistSession: false } });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) { skipped += 1; continue; }
    for (const week of weeks) {
      const result = await compareWeekParts(client, dept, week);
      pairs += WEEK_PARTS.length;
      totalRows += Object.values(result.rows).reduce((n, v) => n + v, 0);
      if (result.differ.length) {
        bad += result.differ.length;
        console.log(`DIFFER user #${emails.indexOf(email)} week ${week}: ${result.differ.join(", ")} ${JSON.stringify(result.errors)}`);
      }
    }
  }
  console.log(`${emails.length - skipped} users × ${weeks.length} week(s): ${pairs} part comparisons, ${totalRows} rows, ${bad} differ${skipped ? `, ${skipped} users could not sign in` : ""}`);
  process.exit(bad ? 1 : 0);
}
