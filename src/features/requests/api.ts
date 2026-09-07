import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database, Json } from "@/integrations/supabase/types";
import type { RequestWindow } from "./window";

/**
 * The only file in the `requests` feature that calls `supabase.from`/`.rpc`.
 *
 * `fetchMyRequests` queries `requests` directly (filtered by
 * `requester_id`) instead of the generated `v_my_requests` view. That view
 * (supabase/migrations/20260907091700_views.sql) is `security_invoker` and
 * selects no `requester_id`/`filed_by` column, so under the base `requests`
 * RLS policy — "own ∨ sadran ∨ admin ∨ **any approved user** when served by
 * a non-draft ride and the week is public" (DATA_MODEL.md §4.3) — a plain
 * member querying it can also get back *other* members' requests from any
 * published siddur, with no column left to filter them back out
 * client-side. That is fine for a future "siddur" reader but wrong for a
 * "my week" feed, so Home queries the base table with an explicit
 * `.eq('requester_id', …)` instead. Flagged in the final report as a
 * data-layer finding, not fixed here (supabase/ is out of scope for stage 1c).
 */
export type RequestStatus = Database["public"]["Enums"]["request_status"];
export type TripShape = Database["public"]["Enums"]["trip_shape"];
export type CarType = Database["public"]["Enums"]["car_type"];
export type RideRole = Database["public"]["Enums"]["ride_role"];
export type ProposalType = Database["public"]["Enums"]["proposal_type"];

export interface MyRequestRide {
  id: string;
  startsAt: string;
  endsAt: string;
  status: Database["public"]["Enums"]["ride_status"];
  originName: string;
  destinationName: string;
  carName: string | null;
  carType: CarType | null;
  driverName: string | null;
  isChauffeur: boolean;
  role: RideRole;
}

export interface MyRequestPendingProposal {
  id: string;
  type: ProposalType;
  reasonHe: string;
  expiresAt: string;
}

export interface MyRequestRow {
  hasPublishedRide?: boolean;
  window?: RequestWindow | null;
  id: string;
  departmentId: string;
  weekStart: string;
  status: RequestStatus;
  statusReason: string | null;
  isLate: boolean;
  changedSinceSolve: boolean;
  departAt: string | null;
  returnAt: string | null;
  tripShape: TripShape;
  destination: string;
  rideTypeId: string;
  rideTypeName: string;
  rideTypeCode: string | null;
  needsCarAtDestination: boolean;
  version: number;
  freedSlotOptOut: boolean;
  /** First placed leg, if any — a split relay's second leg is not shown separately (known simplification, see final report). */
  ride: MyRequestRide | null;
  pendingProposal: MyRequestPendingProposal | null;
}

const SELECT = `
  id, department_id, week_start, status, status_reason, is_late, changed_since_solve,
  depart_at, return_at, trip_shape, needs_car_at_destination, destination_text, version, ride_type_id,
  freed_slot_opt_out,
  window:weeks(phase, open_at, close_at),
  destination:destinations(name),
  ride_type:ride_types(code, name_he),
  ride_requests(
    role,
    ride:rides(
      id, starts_at, ends_at, status,
      origin:destinations!rides_origin_id_fkey(name),
      destination:destinations!rides_destination_id_fkey(name),
      car:cars(name, type),
      driver:profiles!rides_driver_id_fkey(full_name)
    )
  ),
  proposals(id, type, reason_he, expires_at, status)
`;

interface RawRequestRow {
  window: RequestWindow | null;
  id: string;
  department_id: string;
  week_start: string;
  status: RequestStatus;
  status_reason: string | null;
  is_late: boolean;
  changed_since_solve: boolean;
  depart_at: string | null;
  return_at: string | null;
  trip_shape: TripShape;
  needs_car_at_destination: boolean;
  destination_text: string | null;
  version: number;
  freed_slot_opt_out: boolean;
  ride_type_id: string;
  destination: { name: string } | null;
  ride_type: { code: string; name_he: string } | null;
  ride_requests: {
    role: RideRole;
    ride: {
      id: string;
      starts_at: string;
      ends_at: string;
      status: Database["public"]["Enums"]["ride_status"];
      origin: { name: string } | null;
      destination: { name: string } | null;
      car: { name: string; type: CarType } | null;
      driver: { full_name: string } | null;
    } | null;
  }[];
  proposals: {
    id: string;
    type: ProposalType;
    reason_he: string;
    expires_at: string;
    status: Database["public"]["Enums"]["proposal_status"];
  }[];
}

function mapRow(row: RawRequestRow): MyRequestRow {
  const legWithRide = row.ride_requests.find((leg) => leg.ride !== null && leg.ride.status !== "cancelled");
  const ride = legWithRide?.ride ?? null;
  const pendingProposal =
    row.proposals.find((p) => p.status === "sent") ??
    row.proposals.find((p) => p.status === "accepted") ??
    null;

  return {
    window: row.window,
    hasPublishedRide: row.ride_requests.some((link) => link.ride && link.ride.status !== "cancelled" && link.ride.status !== "draft"),
    id: row.id,
    departmentId: row.department_id,
    weekStart: row.week_start,
    status: row.status,
    statusReason: row.status_reason,
    isLate: row.is_late,
    changedSinceSolve: row.changed_since_solve,
    departAt: row.depart_at,
    returnAt: row.return_at,
    tripShape: row.trip_shape,
    destination: row.destination?.name ?? row.destination_text ?? "",
    rideTypeId: row.ride_type_id,
    rideTypeName: row.ride_type?.name_he ?? "",
    rideTypeCode: row.ride_type?.code ?? null,
    needsCarAtDestination: row.needs_car_at_destination,
    version: row.version,
    freedSlotOptOut: row.freed_slot_opt_out,
    ride:
      ride && legWithRide
        ? {
            id: ride.id,
            startsAt: ride.starts_at,
            endsAt: ride.ends_at,
            status: ride.status,
            originName: ride.origin?.name ?? "",
            destinationName: ride.destination?.name ?? "",
            carName: ride.car?.name ?? null,
            carType: ride.car?.type ?? null,
            driverName: ride.driver?.full_name ?? null,
            isChauffeur: legWithRide.role === "passenger" && ride.driver?.full_name !== undefined,
            role: legWithRide.role,
          }
        : null,
    pendingProposal: pendingProposal
      ? {
          id: pendingProposal.id,
          type: pendingProposal.type,
          reasonHe: pendingProposal.reason_he,
          expiresAt: pendingProposal.expires_at,
        }
      : null,
  };
}

export interface RequestEditRow {
  window?: RequestWindow | null;
  hasPublishedRide?: boolean;
  id: string;
  departmentId: string;
  weekStart: string;
  status: RequestStatus;
  version: number;
  destinationId: string | null;
  destinationText: string | null;
  destinationName: string | null;
  rideTypeId: string;
  tripShape: TripShape;
  departAt: string | null;
  returnAt: string | null;
  oneWayCarMode: Database["public"]["Enums"]["leg_car_mode"] | null;
  needsCarAtDestination: boolean;
  adults: number;
  childSeats: number;
  boosters: number;
  hasLuggage: boolean;
  flexDepartEarly: string;
  flexDepartLate: string;
  flexReturnEarly: string;
  flexReturnLate: string;
  notes: string | null;
  changedSinceSolve: boolean;
}

const EDIT_SELECT = `
  id, department_id, week_start, status, version, destination_id, destination_text, ride_type_id,
  trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
  adults, child_seats, boosters, has_luggage,
  flex_depart_early, flex_depart_late, flex_return_early, flex_return_late, notes, changed_since_solve,
  destination:destinations(name),
  window:weeks(phase, open_at, close_at),
  ride_requests(ride:rides(status))
`;

/** Explicit owner filter: published-request RLS also permits reading other members' requests. */
export async function fetchRequestById(requestId: string, profileId: string): Promise<RequestEditRow | null> {
  const { data, error } = await supabase.from("requests").select(EDIT_SELECT).eq("id", requestId).eq("requester_id", profileId).maybeSingle();
  if (error) throw toAppError(error);
  if (!data) return null;
  const row = data as unknown as {
    window: RequestWindow | null;
    ride_requests: { ride: { status: string } | null }[];
    id: string;
    department_id: string;
    week_start: string;
    status: RequestStatus;
    version: number;
    destination_id: string | null;
    destination_text: string | null;
    ride_type_id: string;
    trip_shape: TripShape;
    depart_at: string | null;
    return_at: string | null;
    one_way_car_mode: Database["public"]["Enums"]["leg_car_mode"] | null;
    needs_car_at_destination: boolean;
    adults: number;
    child_seats: number;
    boosters: number;
    has_luggage: boolean;
    flex_depart_early: string;
    flex_depart_late: string;
    flex_return_early: string;
    flex_return_late: string;
    notes: string | null;
    changed_since_solve: boolean;
    destination: { name: string } | null;
  };
  return {
    window: row.window,
    hasPublishedRide: row.ride_requests.some((link) => link.ride && link.ride.status !== "cancelled" && link.ride.status !== "draft"),
    id: row.id,
    departmentId: row.department_id,
    weekStart: row.week_start,
    status: row.status,
    version: row.version,
    destinationId: row.destination_id,
    destinationText: row.destination_text,
    destinationName: row.destination?.name ?? null,
    rideTypeId: row.ride_type_id,
    tripShape: row.trip_shape,
    departAt: row.depart_at,
    returnAt: row.return_at,
    oneWayCarMode: row.one_way_car_mode,
    needsCarAtDestination: row.needs_car_at_destination,
    adults: row.adults,
    childSeats: row.child_seats,
    boosters: row.boosters,
    hasLuggage: row.has_luggage,
    flexDepartEarly: row.flex_depart_early,
    flexDepartLate: row.flex_depart_late,
    flexReturnEarly: row.flex_return_early,
    flexReturnLate: row.flex_return_late,
    notes: row.notes,
    changedSinceSolve: row.changed_since_solve,
  };
}

export async function fetchMyRequests(profileId: string): Promise<MyRequestRow[]> {
  const { data, error } = await supabase
    .from("requests")
    .select(SELECT)
    .eq("requester_id", profileId)
    .order("depart_at", { ascending: true, nullsFirst: false });
  if (error) throw toAppError(error);
  return ((data ?? []) as unknown as RawRequestRow[]).map(mapRow);
}

export interface SubmitRequestPayload {
  department_id: string;
  week_start: string;
  destination_id?: string;
  destination_text?: string;
  ride_type_id: string;
  trip_shape: TripShape;
  depart_at?: string;
  return_at?: string;
  adults: number;
  child_seats: number;
  boosters: number;
  has_luggage?: boolean;
  needs_car_at_destination?: boolean;
  one_way_car_mode?: Database["public"]["Enums"]["leg_car_mode"];
  flex_depart_early?: string;
  flex_depart_late?: string;
  flex_return_early?: string;
  flex_return_late?: string;
  notes?: string;
  request_id?: string;
  expected_version?: number;
  join_ride_id?: string;
  requester_id?: string;
  /**
   * Optional car the member asked for (quick-request-from-empty-slot, UX_FLOWS.md §18); in a
   * live week `try_auto_approve()` tries it first, falling back to any free car exactly as
   * before if it's busy (`supabase/migrations/20260907093200_quick_request_preferred_car.sql`).
   */
  preferred_car_id?: string;
}

/**
 * `submit_request`'s response, extended backward-compatibly (DATA_MODEL.md §6.1 item 24):
 * `status`/`ride_id`/`car_id`/`reason` are only present for a live-week submission (where
 * `try_auto_approve()` ran) — every other caller only ever read `request_id`/`is_late`/
 * `warnings`, which are unchanged.
 */
export interface SubmitRequestResult {
  request_id: string;
  is_late: boolean;
  warnings: string[];
  status?: "assigned" | "waitlisted";
  ride_id?: string;
  car_id?: string;
  reason?: string;
}

/** `submit_request(payload jsonb)` — the only write path for requests (CLAUDE.md decision 8). */
export async function submitRequest(payload: SubmitRequestPayload): Promise<Json> {
  return rpc("submit_request", { payload: payload as unknown as Json });
}

export async function withdrawRequest(requestId: string, expectedVersion: number): Promise<void> {
  await rpc("withdraw_request", { p_request_id: requestId, p_expected_version: expectedVersion });
}

/** Member cancels their own ride (or a Sadran/Admin, `can_manage_week`); frees the slot (REQ §8). */
export async function cancelRide(
  rideId: string,
  reason: string,
  expectedVersion?: number,
): Promise<void> {
  await rpc("cancel_ride", { p_ride_id: rideId, p_reason: reason, p_expected_version: expectedVersion });
}

/** "I still want it" on a freed-slot offer addressed to me (DATA_MODEL §3.10). */
export async function claimFreedSlot(offerId: string, requestId: string): Promise<void> {
  await rpc("claim_freed_slot", { p_offer_id: offerId, p_request_id: requestId });
}

export async function withdrawFreedSlotClaim(offerId: string, requestId: string): Promise<void> {
  await rpc("withdraw_freed_slot_claim", { p_offer_id: offerId, p_request_id: requestId });
}

/**
 * `set_freed_slot_opt_out(request_id, opt_out)` (Stage 3 hardening fix #3,
 * `supabase/migrations/20260907092700_set_freed_slot_opt_out.sql`) — a dedicated RPC for
 * flipping just this one column on an existing request (owner or the Sadran of the week),
 * used by the "My requests" list and, when a session exists, `/p/:token`'s deny/external
 * variant checkbox. `submit_request`'s update branch does not coalesce every field, so
 * reusing it here would null out destination/timing data (UX_FLOWS.md §14 item 3).
 */
export async function setFreedSlotOptOut(requestId: string, optOut: boolean): Promise<void> {
  await rpc("set_freed_slot_opt_out", { p_request_id: requestId, p_opt_out: optOut });
}

export interface MyFreedSlotOfferRow {
  offerId: string;
  requestId: string;
  claimStatus: Database["public"]["Enums"]["freed_claim_status"];
  offerStatus: Database["public"]["Enums"]["freed_offer_status"];
  carName: string;
  destinationName: string;
  startsAt: string;
  endsAt: string;
  expiresAt: string;
}

/** Freed-slot offers where I am a candidate (`freed_slot_claims.profile_id = me`), open ones first. */
export async function fetchMyFreedSlotOffers(profileId: string): Promise<MyFreedSlotOfferRow[]> {
  const { data, error } = await supabase
    .from("freed_slot_claims")
    .select(
      `status, request_id,
       offer:freed_slot_offers(id, status, starts_at, ends_at, expires_at,
         car:cars(name),
         cancelled_ride:rides!freed_slot_offers_cancelled_ride_id_fkey(destination:destinations(name)))`,
    )
    .eq("profile_id", profileId)
    .order("offered_at", { ascending: false });
  if (error) throw toAppError(error);

  interface Raw {
    status: Database["public"]["Enums"]["freed_claim_status"];
    request_id: string;
    offer: {
      id: string;
      status: Database["public"]["Enums"]["freed_offer_status"];
      starts_at: string;
      ends_at: string;
      expires_at: string;
      car: { name: string } | null;
      cancelled_ride: { destination: { name: string } | null } | null;
    } | null;
  }

  return ((data ?? []) as unknown as Raw[])
    .filter((row) => row.offer !== null)
    .map((row) => ({
      offerId: row.offer!.id,
      requestId: row.request_id,
      claimStatus: row.status,
      offerStatus: row.offer!.status,
      carName: row.offer!.car?.name ?? "",
      destinationName: row.offer!.cancelled_ride?.destination?.name ?? "",
      startsAt: row.offer!.starts_at,
      endsAt: row.offer!.ends_at,
      expiresAt: row.offer!.expires_at,
    }));
}

/** Companions of a request (`request_companions`, REQ §13.26) — replaces the full set on save. */
export async function fetchRequestCompanionIds(requestId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("request_companions")
    .select("profile_id")
    .eq("request_id", requestId);
  if (error) throw toAppError(error);
  return (data ?? []).map((row) => row.profile_id);
}

export async function setRequestCompanions(requestId: string, profileIds: string[]): Promise<void> {
  const { error: deleteError } = await supabase
    .from("request_companions")
    .delete()
    .eq("request_id", requestId);
  if (deleteError) throw toAppError(deleteError);

  if (profileIds.length === 0) return;
  const { error: insertError } = await supabase
    .from("request_companions")
    .insert(profileIds.map((profileId) => ({ request_id: requestId, profile_id: profileId })));
  if (insertError) throw toAppError(insertError);
}

export async function withdrawAllRequests(departmentId: string, weekStart: string): Promise<void> {
  await rpc("withdraw_all_requests", { p_department_id: departmentId, p_week_start: weekStart });
}
