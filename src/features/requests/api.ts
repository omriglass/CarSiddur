import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";
import { siddurCarName } from "@/lib/siddurCarName";

import { templateSuggestionRowSchema, type TemplateSuggestionRow } from "./schema";

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
  needsDriver?: boolean;
  version?: number;
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
  /** No timer any more (20260910090000): null until the proposal's day is published or has passed. */
  expiresAt: string | null;
}

export interface MyRequestRow {
  preferredCarId?: string | null;
  preferredCarName?: string | null;
  hasPublishedRide?: boolean;
  window?: RequestWindow | null;
  /** Named children on this request (`request_children` → `children.full_name`), UX_FLOWS.md §4.2. */
  childNames?: string[];
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
  /** Links to `request_templates` (DATA_MODEL §3.6) when this request came from — or was marked as — a repeating request. */
  templateId: string | null;
  /** Multi-day request ("series", REQ §13.77) — `null` for an ordinary single-day request. */
  seriesId: string | null;
  /** 1-based position of this leg within its series. */
  seriesIndex: number | null;
  /** Total number of legs (calendar days) in this leg's series. */
  seriesCount: number | null;
}

const SELECT = `
  id, department_id, week_start, status, status_reason, is_late, changed_since_solve,
  depart_at, return_at, trip_shape, needs_car_at_destination, destination_text, version, ride_type_id,
  freed_slot_opt_out, preferred_car_id, template_id, series_id, series_index, series_count,
  preferred_car:cars!requests_preferred_car_id_fkey(name),
  window:weeks(phase, open_at, close_at),
  destination:destinations(name),
  ride_type:ride_types(code, name_he),
  ride_requests(
    role,
    ride:rides(
      id, starts_at, ends_at, status, needs_driver, version,
      origin:destinations!rides_origin_id_fkey(name),
      destination:destinations!rides_destination_id_fkey(name),
      car:cars(name, type, access_code, is_replaced, replacement_code),
      driver:profiles!rides_driver_id_fkey(full_name)
    )
  ),
  proposals(id, type, reason_he, expires_at, status),
  request_children(child:children(full_name))
`;

interface RawRequestRow {
  preferred_car_id: string | null;
  preferred_car: { name: string } | null;
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
  template_id: string | null;
  series_id: string | null;
  series_index: number | null;
  series_count: number | null;
  destination: { name: string } | null;
  ride_type: { code: string; name_he: string } | null;
  ride_requests: {
    role: RideRole;
    ride: {
      needs_driver: boolean;
      version: number;
      id: string;
      starts_at: string;
      ends_at: string;
      status: Database["public"]["Enums"]["ride_status"];
      origin: { name: string } | null;
      destination: { name: string } | null;
      car: { name: string; type: CarType; access_code: string | null; is_replaced: boolean; replacement_code: string | null } | null;
      driver: { full_name: string } | null;
    } | null;
  }[];
  proposals: {
    id: string;
    type: ProposalType;
    reason_he: string;
    expires_at: string | null;
    status: Database["public"]["Enums"]["proposal_status"];
  }[];
  request_children: { child: { full_name: string } | null }[];
}

function mapRow(row: RawRequestRow): MyRequestRow {
  const legWithRide = row.ride_requests.find((leg) => leg.ride !== null && leg.ride.status !== "cancelled");
  const ride = legWithRide?.ride ?? null;
  const pendingProposal =
    row.proposals.find((p) => p.status === "sent") ??
    row.proposals.find((p) => p.status === "accepted") ??
    null;

  return {
    preferredCarId: row.preferred_car_id,
    preferredCarName: row.preferred_car?.name ?? null,
    window: row.window,
    hasPublishedRide: row.ride_requests.some((link) => link.ride && link.ride.status !== "cancelled" && link.ride.status !== "draft"),
    childNames: row.request_children.flatMap((entry) => entry.child?.full_name ? [entry.child.full_name] : []),
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
    templateId: row.template_id,
    seriesId: row.series_id,
    seriesIndex: row.series_index,
    seriesCount: row.series_count,
    ride:
      ride && legWithRide
        ? {
            needsDriver: ride.needs_driver,
            version: ride.version,
            id: ride.id,
            startsAt: ride.starts_at,
            endsAt: ride.ends_at,
            status: ride.status,
            originName: ride.origin?.name ?? "",
            destinationName: ride.destination?.name ?? "",
            carName: ride.car ? siddurCarName(ride.car) : null,
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
  preferredCarId?: string | null;
  preferredCarName?: string | null;
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
  rideDescription: string | null;
  guestPassengerNames: string[];
  changedSinceSolve: boolean;
  /** Links to `request_templates` (DATA_MODEL §3.6) — drives the edit form's "repeat weekly" switch default. */
  templateId: string | null;
}

const EDIT_SELECT = `
  id, department_id, week_start, status, version, destination_id, destination_text, ride_type_id,
  trip_shape, depart_at, return_at, one_way_car_mode, needs_car_at_destination,
  adults, child_seats, boosters, has_luggage,
  flex_depart_early, flex_depart_late, flex_return_early, flex_return_late, notes, ride_description, guest_passenger_names, changed_since_solve, preferred_car_id, template_id,
  preferred_car:cars!requests_preferred_car_id_fkey(name),
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
    preferred_car_id: string | null;
    preferred_car: { name: string } | null;
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
    ride_description: string | null;
    guest_passenger_names: string[];
    changed_since_solve: boolean;
    template_id: string | null;
    destination: { name: string } | null;
  };
  return {
    preferredCarId: row.preferred_car_id,
    preferredCarName: row.preferred_car?.name ?? null,
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
    rideDescription: row.ride_description,
    guestPassengerNames: row.guest_passenger_names ?? [],
    changedSinceSolve: row.changed_since_solve,
    templateId: row.template_id,
  };
}

export async function fetchMyRequests(profileId: string, departmentId?: string): Promise<MyRequestRow[]> {
  let query = supabase.from("requests").select(SELECT).eq("requester_id", profileId);
  if (departmentId) query = query.eq("department_id", departmentId);
  const { data, error } = await query.order("depart_at", { ascending: true, nullsFirst: false });
  if (error) throw toAppError(error);
  // A withdrawn/cancelled request is terminal and no longer actionable.  Keep
  // it out of the member feed even when it was withdrawn by a coordinator on
  // the member's behalf.
  return ((data ?? []) as unknown as RawRequestRow[])
    .filter((row) => !["withdrawn", "cancelled"].includes(row.status))
    .map(mapRow);
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
  /** Public ride text, independent of the private coordinator notes. */
  ride_description?: string | null;
  guest_passenger_names?: string[];
  companion_ids?: string[];
  /** New live one-way quick request: reserve a vehicle while awaiting a driver. */
  reserve_missing_driver?: boolean;
  request_id?: string;
  expected_version?: number;
  join_ride_id?: string;
  requester_id?: string;
  /**
   * Optional shared-car preference from the normal form or quick request (UX_FLOWS.md §21).
   * Feasible alternatives remain allowed. Explicit null clears an existing preference;
   * omission preserves it when editing through callers that do not expose this field.
   */
  preferred_car_id?: string | null;
  /** Published-day request which waits for a freed slot instead of altering the Siddur. */
  waitlist?: boolean;
  /**
   * Links the created/edited request straight to an existing `request_templates` row
   * (repeating-request suggestion prefill, `/requests/new?template=<id>`, REQ §76) — the
   * suggestion then disappears for this week the moment the request exists, regardless of
   * whether the member keeps the "repeat weekly" switch on. Omitted for a plain new request;
   * `save_request_template`/`stop_request_template` (`RequestForm`'s own follow-up calls)
   * manage the link for every other case.
   */
  template_id?: string;
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
  needs_driver?: boolean;
  starts_at?: string;
  ends_at?: string;
  /**
   * `enter_waiting_list()` (20260909093000_extend_auto_approve_and_waitlist.sql): the member
   * asked to join the waiting list, but a car was actually free and the request was placed
   * instead — `status` is `"assigned"` alongside this flag, distinct from a plain assigned
   * result so the UI can say "no waiting list needed" rather than the ordinary success toast.
   */
  car_was_free?: boolean;
}

/** `submit_request(payload jsonb)` — the only write path for requests (CLAUDE.md decision 8). */
export async function submitRequest(payload: SubmitRequestPayload): Promise<Json> {
  if (payload.waitlist) return rpc("enter_waiting_list", { p_payload: payload as unknown as Json });
  return rpc("submit_request", { payload: payload as unknown as Json });
}

/**
 * `submit_series_request`'s response (REQ §13.77): always `series_id`/`request_ids`/
 * `warnings` (one request per calendar day of the span); `status`/`reason`/`car_id`/
 * `ride_ids`/`weeks` are only present when the first day's week is already
 * published/live (`try_auto_approve_series()` ran) — `status` is `"assigned"` (reason
 * `SERIES_PLACED`) or `"waitlisted"` (reason `WAITLISTED_SERIES_NO_CAR`).
 */
export interface SubmitSeriesRequestResult {
  series_id: string;
  request_ids: string[];
  warnings: string[];
  status?: "assigned" | "waitlisted";
  reason?: string;
  car_id?: string;
  ride_ids?: string[];
  weeks?: string[];
}

/**
 * `submit_series_request(payload jsonb)` — the only write path for a multi-day request
 * (REQ §13.77): same payload shape as `submit_request`, except `return_at` is on a LATER
 * Jerusalem date than `depart_at` (`mapper.ts`'s `returnDay`-aware `return_at`). Never send
 * `request_id`/`expected_version` — editing a series is not supported in v1 (`series_edit_
 * not_supported`, MDR02); cancel and resubmit instead.
 */
export async function submitSeriesRequest(payload: SubmitRequestPayload): Promise<Json> {
  return rpc("submit_series_request", { payload: payload as unknown as Json });
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

export async function fetchRequestChildIds(requestId: string): Promise<string[]> {
  const { data, error } = await supabase.from("request_children").select("child_id").eq("request_id", requestId);
  if (error) throw toAppError(error);
  return (data ?? []).map((row) => row.child_id);
}

export async function setRequestChildren(requestId: string, childIds: string[]): Promise<void> {
  await rpc("set_request_children", { p_request_id: requestId, p_child_ids: childIds });
}

export async function withdrawAllRequests(departmentId: string, weekStart: string): Promise<void> {
  await rpc("withdraw_all_requests", { p_department_id: departmentId, p_week_start: weekStart });
}

/** Camel-cased, zod-validated `v_request_template_suggestions` row (DATA_MODEL §3.6, REQ §76). */
export interface TemplateSuggestion {
  templateId: string;
  departmentId: string;
  weekStart: string;
  destinationId: string | null;
  destinationText: string | null;
  destinationName: string | null;
  rideTypeId: string;
  rideTypeName: string | null;
  tripShape: TripShape;
  departDow: number | null;
  departTime: string | null;
  returnDow: number | null;
  returnTime: string | null;
  /** Already anchored to `weekStart` (computed in SQL from `departDow`/`departTime`). */
  departAt: string | null;
  returnAt: string | null;
  oneWayCarMode: Database["public"]["Enums"]["leg_car_mode"] | null;
  needsCarAtDestination: boolean;
  adults: number;
  childSeats: number;
  boosters: number;
  childIds: string[];
  companionIds: string[];
  hasLuggage: boolean;
  flexDepartEarly: string;
  flexDepartLate: string;
  flexReturnEarly: string;
  flexReturnLate: string;
  preferredCarId: string | null;
  rideDescription: string | null;
  guestPassengerNames: string[];
  notes: string | null;
}

function mapTemplateSuggestion(row: TemplateSuggestionRow): TemplateSuggestion {
  return {
    templateId: row.template_id,
    departmentId: row.department_id,
    weekStart: row.week_start,
    destinationId: row.destination_id,
    destinationText: row.destination_text,
    destinationName: row.destination_name,
    rideTypeId: row.ride_type_id,
    rideTypeName: row.ride_type_name,
    tripShape: row.trip_shape,
    departDow: row.depart_dow,
    departTime: row.depart_time,
    returnDow: row.return_dow,
    returnTime: row.return_time,
    departAt: row.depart_at,
    returnAt: row.return_at,
    oneWayCarMode: row.one_way_car_mode,
    needsCarAtDestination: row.needs_car_at_destination ?? true,
    adults: row.adults,
    childSeats: row.child_seats,
    boosters: row.boosters,
    childIds: row.child_ids,
    companionIds: row.companion_ids,
    hasLuggage: row.has_luggage ?? false,
    flexDepartEarly: row.flex_depart_early,
    flexDepartLate: row.flex_depart_late,
    flexReturnEarly: row.flex_return_early,
    flexReturnLate: row.flex_return_late,
    preferredCarId: row.preferred_car_id,
    rideDescription: row.ride_description,
    guestPassengerNames: row.guest_passenger_names,
    notes: row.notes,
  };
}

const TEMPLATE_SUGGESTION_SELECT = `
  template_id, department_id, week_start, destination_id, destination_text, destination_name,
  ride_type_id, ride_type_name, trip_shape, depart_dow, depart_time, return_dow, return_time,
  depart_at, return_at, one_way_car_mode, needs_car_at_destination, adults, child_seats, boosters,
  child_ids, companion_ids, has_luggage, flex_depart_early, flex_depart_late, flex_return_early,
  flex_return_late, preferred_car_id, ride_description, guest_passenger_names, notes
`;

/** Repeating-request suggestions for the caller's own open week(s) (REQ §76, DATA_MODEL §3.6). */
export async function fetchTemplateSuggestions(): Promise<TemplateSuggestion[]> {
  const { data, error } = await supabase
    .from("v_request_template_suggestions")
    .select(TEMPLATE_SUGGESTION_SELECT)
    .order("week_start", { ascending: true })
    .order("depart_at", { ascending: true, nullsFirst: false });
  if (error) throw toAppError(error);
  return (data ?? []).map((row) => mapTemplateSuggestion(templateSuggestionRowSchema.parse(row)));
}

/** Creates or updates the caller's template from one of their own requests, linking it back. */
export async function saveRequestTemplate(requestId: string): Promise<string> {
  return rpc("save_request_template", { p_request_id: requestId });
}

/** "Not this week" — suggestions for this template resume the following week. */
export async function snoozeRequestTemplate(templateId: string, weekStart: string): Promise<void> {
  await rpc("snooze_request_template", { p_template_id: templateId, p_week_start: weekStart });
}

/** "Stop repeating" — reversible via `resume_request_template` (not yet exposed in the UI). */
export async function stopRequestTemplate(templateId: string): Promise<void> {
  await rpc("stop_request_template", { p_template_id: templateId });
}
