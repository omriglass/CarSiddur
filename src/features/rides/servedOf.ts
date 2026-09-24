// Pure reader of `v_board_rides.served` — deliberately free of any solver/React/Supabase
// import so Home, the siddur and the ride sheets (eager member bundle) can use it without
// dragging `src/solver/**` into the first paint (owner, 2026-09-14: bundle-size cleanup).
// `applySolve.ts` re-exports it so every existing `from "../applySolve"`/`solverRun` import
// keeps working.
import type { BoardRide } from "./api";

export interface ServedEntry {
  ride_description?: string | null;
  guest_passenger_names?: string[];
  companions?: { profile_id: string; name: string }[];
  request_id: string | null;
  role: "driver" | "passenger";
  leg: "out" | "return" | "both";
  car_mode: "keep" | "relay" | "passenger" | "chauffeur";
  adults: number;
  child_seats: number;
  boosters: number;
  luggage: boolean;
  /** `v_board_rides.served[].requester` — the request's `profiles.full_name` (board label, bug #3). */
  requester?: string | null;
  /** `v_board_rides.served[].destination` — `coalesce(destinations.name, requests.destination_text)`. */
  destination?: string | null;
  /** `v_board_rides.served[].ride_type` — `ride_types.code` (visual pass: ride-type block coloring, `src/lib/rideTypeColors.ts`). Already selected by the view; no new query needed. */
  ride_type?: string | null;
  /**
   * Named children (`request_children` → `children.full_name`). Mapped directly from
   * `v_board_rides.served[].child_names`
   * (`supabase/migrations/20260909094000_add_child_names_to_published_views.sql`) by
   * `servedOf()` below — every reader of `servedOf()` gets child names for free, no
   * further join needed. `withChildNames()` remains a *second*, sadran-board-only
   * enrichment path (joining against a separately-fetched `WeekRequestRow[]`,
   * `features/sadran/api.ts`'s `WEEK_REQUEST_SELECT`) — harmless to run on top of this
   * (it only overwrites when it has its own non-empty names), kept as-is.
   */
  childNames?: string[];
}

/** Reads `v_board_rides.served` (a jsonb aggregate, RideDetailSheet.tsx uses the same shape) into typed rows. */
export function servedOf(ride: BoardRide): ServedEntry[] {
  const raw = (ride.served as unknown as (ServedEntry & { child_names?: string[] })[] | null) ?? [];
  return raw
    .filter((s) => !!s.request_id)
    .map((s) => (s.child_names?.length ? { ...s, childNames: s.child_names } : s));
}

/** A `ride_passengers` row (F3, 20260914120000_ride_passengers.sql) — a named person or child on a ride with no `requests` row behind them. */
export interface RidePassengerEntry {
  id: string;
  person_id: string | null;
  child_id: string | null;
  display_name: string;
  seat_kind: "adult" | "child_seat" | "booster";
  /** Who added this row — the "+ נוסעים" button, 20260914170000_add_ride_passengers_rpc.sql; lets the UI show a remove (×) to the adder, not just the driver/named person/week manager. */
  added_by: string | null;
}

/** Reads `v_board_rides.passengers` (a jsonb aggregate, same idiom as `servedOf()`) into typed rows. */
export function namedPassengersOf(ride: BoardRide): RidePassengerEntry[] {
  return (ride.passengers as unknown as RidePassengerEntry[] | null) ?? [];
}

/**
 * Attaches named children to already-`servedOf()`'d entries by matching
 * `request_id` against a `WeekRequestRow[]` (which already embeds
 * `request_children` → `children.full_name`, `features/sadran/api.ts`) —
 * works for the Sadran board (RLS already lets a manager of the week read
 * every request's `request_children` rows) since `requestsQuery` there
 * fetches every request in the week, served or not. Does **not** help the
 * read-only published siddur for a non-Sadran member: `v_board_rides` itself
 * has no child-name column, and `request_children`'s RLS only allows the
 * requester or a week manager to read it (no "published" policy exists yet,
 * unlike `request_companions_published_select`) — that gap needs a
 * migration (see UX_FLOWS.md / hand-off notes), not more client code.
 */
export function withChildNames(entries: readonly ServedEntry[], requests: readonly { id: string; childNames?: string[] }[]): ServedEntry[] {
  if (!entries.length) return entries as ServedEntry[];
  const byId = new Map(requests.map((r) => [r.id, r.childNames ?? []]));
  return entries.map((entry) => {
    const names = entry.request_id ? byId.get(entry.request_id) : undefined;
    return names?.length ? { ...entry, childNames: names } : entry;
  });
}

/**
 * One `ride_types.code` to color the whole block/card by (visual pass,
 * `src/lib/rideTypeColors.ts`): the driver's own request, or the first
 * served passenger if there's no driver leg for some reason, or `null` (the
 * caller's color map falls back to `"other"`). A merged ride can serve
 * requests of different types — this is a deliberate single-color
 * simplification, same spirit as `boardRideToFixedRide`'s origin/destination
 * one above.
 */
export function representativeRideTypeCode(served: readonly ServedEntry[]): string | null {
  const driver = served.find((s) => s.role === "driver");
  return driver?.ride_type ?? served[0]?.ride_type ?? null;
}
