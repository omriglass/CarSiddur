import { supabase } from "@/integrations/supabase/client";
import { ageFromBirthYear, isAdultPassenger } from "@/lib/childAge";
import { isActiveStop, parseRouteStops, type RouteStop } from "@/lib/routeStops";
import { rpc, toAppError } from "@/lib/rpc";
import { siddurCarName } from "@/lib/siddurCarName";

import { pickPendingProposal } from "./pendingProposal";
import { joinableRideRowSchema, templateSuggestionRowSchema, type TemplateSuggestionRow } from "./schema";

import type { DestinationValue } from "@/components/DestinationCombobox";
import type { Json } from "@/integrations/supabase/types";
import type {
  CarType,
  FreedClaimStatus,
  FreedOfferStatus,
  LegCarMode,
  ProposalStatus,
  ProposalType,
  RequestStatus,
  RideRole,
  RideStatus,
  TripShape,
  TripType,
} from "@/lib/enums";
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
export type { RequestStatus, TripShape, TripType, CarType, RideRole, ProposalType };

export interface MyRequestRide {
  needsDriver?: boolean;
  version?: number;
  id: string;
  startsAt: string;
  endsAt: string;
  status: RideStatus;
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
  hasLuggage?: boolean;
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
  /** REQ §13.93: `requests.origin_id`/`origin_text`, resolved name joined in `SELECT`. */
  originId: string | null;
  originText: string | null;
  originName: string | null;
  /** REQ §13.93 "Multi-stop rides": out/return waypoints, already leg+position-ordered — `originDestinationLabel()` reads the out-leg names. */
  stops: RouteStop[];
  tripType: TripType;
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
  /** R4U6: the member accepted a proposal that still waits for the other parties. */
  acceptedAwaitingOthers?: boolean;
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
  origin_id, origin_text, trip_type,
  freed_slot_opt_out, has_luggage, preferred_car_id, template_id, series_id, series_index, series_count,
  preferred_car:cars!requests_preferred_car_id_fkey(name),
  window:weeks(phase, open_at, close_at),
  destination:destinations!requests_destination_id_fkey(name),
  origin:destinations!requests_origin_id_fkey(name),
  stops:request_stops(leg, position, place_id, place_text, place:destinations(name)),
  ride_type:ride_types(code, name_he),
  ride_requests(
    role,
    ride:rides(
      id, starts_at, ends_at, status, needs_driver, version,
      origin:destinations!rides_origin_id_fkey(name),
      destination:destinations!rides_destination_id_fkey(name),
      car:cars(name, type, codes:car_access_codes(access_code, is_replaced, replacement_code)),
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
  has_luggage: boolean | null;
  ride_type_id: string;
  origin_id: string | null;
  origin_text: string | null;
  trip_type: TripType;
  template_id: string | null;
  series_id: string | null;
  series_index: number | null;
  series_count: number | null;
  destination: { name: string } | null;
  origin: { name: string } | null;
  stops: { leg: "out" | "return"; position: number; active?: boolean; place_id: string | null; place_text: string | null; place: { name: string } | null }[];
  ride_type: { code: string; name_he: string } | null;
  ride_requests: {
    role: RideRole;
    ride: {
      needs_driver: boolean;
      version: number;
      id: string;
      starts_at: string;
      ends_at: string;
      status: RideStatus;
      origin: { name: string } | null;
      destination: { name: string } | null;
      car: {
        name: string;
        type: CarType;
        codes: { access_code: string | null; is_replaced: boolean; replacement_code: string | null } | { access_code: string | null; is_replaced: boolean; replacement_code: string | null }[] | null;
      } | null;
      driver: { full_name: string } | null;
    } | null;
  }[];
  proposals: {
    id: string;
    type: ProposalType;
    reason_he: string;
    expires_at: string | null;
    status: ProposalStatus;
  }[];
  request_children: { child: { full_name: string } | null }[];
}

/**
 * `SELECT`'s `stops:request_stops(...)` embed (nested `place:destinations(name)`, no `eta` — this
 * queries the base `requests` table directly, not `v_my_requests`/`request_stop_etas()`) into the
 * shared `RouteStop[]` shape (REQ §13.93 "Multi-stop rides"). `/my`'s one-line label only needs
 * out-stop *names*, never a computed ETA.
 */
function mapEmbeddedStops(rows: RawRequestRow["stops"], hasReturn: boolean): RouteStop[] {
  return (rows ?? [])
    .filter((s) => isActiveStop(s, hasReturn))
    .map((s) => ({
      leg: s.leg,
      position: s.position,
      placeId: s.place_id,
      placeText: s.place_text,
      name: s.place?.name ?? s.place_text ?? "",
      eta: null,
      active: true,
    }))
    .sort((a, b) => a.position - b.position);
}

function mapRow(row: RawRequestRow): MyRequestRow {
  const legWithRide = row.ride_requests.find((leg) => leg.ride !== null && leg.ride.status !== "cancelled");
  const ride = legWithRide?.ride ?? null;
  const pendingProposal = pickPendingProposal(row.proposals);

  return {
    preferredCarId: row.preferred_car_id,
    preferredCarName: row.preferred_car?.name ?? null,
    window: row.window,
    hasLuggage: row.has_luggage ?? false,
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
    originId: row.origin_id,
    originText: row.origin_text,
    originName: row.origin?.name ?? row.origin_text ?? null,
    stops: mapEmbeddedStops(row.stops, row.return_at != null),
    tripType: row.trip_type,
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
            carName: ride.car
              ? siddurCarName({
                  name: ride.car.name,
                  type: ride.car.type,
                  ...(Array.isArray(ride.car.codes) ? ride.car.codes[0] : ride.car.codes),
                })
              : null,
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
    acceptedAwaitingOthers: !pendingProposal && row.proposals.some((p) => p.status === "accepted"),
  };
}

export interface RequestEditRow {
  preferredCarId?: string | null;
  preferredCarName?: string | null;
  window?: RequestWindow | null;
  hasPublishedRide?: boolean;
  seriesId?: string | null;
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
  /** REQ §13.93: `requests.origin_id`/`origin_text`/`trip_type`. */
  originId: string | null;
  originText: string | null;
  originName: string | null;
  /** REQ §13.93 "Multi-stop rides": prefill-ready form values (`RequestForm.tsx`'s `mapEditRowToValues`). */
  outStops: DestinationValue[];
  returnStops: DestinationValue[];
  tripType: TripType;
  departAt: string | null;
  returnAt: string | null;
  /** REQ §3.4: the return time a one-way request keeps (`requests.kept_return_at`), so switching back restores it. */
  keptReturnAt: string | null;
  oneWayCarMode: LegCarMode | null;
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
  trip_shape, depart_at, return_at, kept_return_at, one_way_car_mode, needs_car_at_destination,
  origin_id, origin_text, trip_type,
  adults, child_seats, boosters, has_luggage,
  flex_depart_early, flex_depart_late, flex_return_early, flex_return_late, notes, ride_description, guest_passenger_names, changed_since_solve, preferred_car_id, template_id, series_id,
  preferred_car:cars!requests_preferred_car_id_fkey(name),
  destination:destinations!requests_destination_id_fkey(name),
  origin:destinations!requests_origin_id_fkey(name),
  stops:request_stops(leg, position, place_id, place_text, place:destinations(name)),
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
    kept_return_at: string | null;
    series_id: string | null;
    id: string;
    department_id: string;
    week_start: string;
    status: RequestStatus;
    version: number;
    destination_id: string | null;
    destination_text: string | null;
    ride_type_id: string;
    trip_shape: TripShape;
    origin_id: string | null;
    origin_text: string | null;
    trip_type: TripType;
    depart_at: string | null;
    return_at: string | null;
    one_way_car_mode: LegCarMode | null;
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
    origin: { name: string } | null;
    stops: { leg: "out" | "return"; position: number; active?: boolean; place_id: string | null; place_text: string | null; place: { name: string } | null }[];
  };
  const outStops: DestinationValue[] = row.stops
    .filter((s) => s.leg === "out")
    .sort((a, b) => a.position - b.position)
    .map((s) => (s.place_id ? { presetId: s.place_id, name: s.place?.name ?? "" } : { freeText: s.place_text ?? "" }));
  // REQ §13.97: inactive return stops (kept on a one-way request) are loaded too, so the form
  // keeps them hidden and a switch back to a return leg restores them.
  const returnStops: DestinationValue[] = row.stops
    .filter((s) => s.leg === "return")
    .sort((a, b) => a.position - b.position)
    .map((s) => (s.place_id ? { presetId: s.place_id, name: s.place?.name ?? "" } : { freeText: s.place_text ?? "" }));
  return {
    preferredCarId: row.preferred_car_id,
    preferredCarName: row.preferred_car?.name ?? null,
    window: row.window,
    seriesId: row.series_id,
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
    originId: row.origin_id,
    originText: row.origin_text,
    originName: row.origin?.name ?? row.origin_text ?? null,
    outStops,
    returnStops,
    tripType: row.trip_type,
    departAt: row.depart_at,
    returnAt: row.return_at,
    keptReturnAt: row.kept_return_at ?? null,
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

/** REQ §13.101 e (QM4): a request the Sadran withdrew as a duplicate stays visible so the member can restore it. */
function isDuplicateWithdrawn(row: { status: string; status_reason: string | null; depart_at: string | null; return_at: string | null }): boolean {
  if (row.status !== "withdrawn" || row.status_reason !== "DUPLICATE_WITHDRAWN") return false;
  const end = Math.max(row.depart_at ? Date.parse(row.depart_at) : 0, row.return_at ? Date.parse(row.return_at) : 0);
  return end > Date.now();
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
    .filter((row) => !["withdrawn", "cancelled"].includes(row.status) || isDuplicateWithdrawn(row))
    .map(mapRow);
}

export interface SubmitRequestPayload {
  department_id: string;
  week_start: string;
  destination_id?: string;
  destination_text?: string;
  ride_type_id: string;
  trip_shape: TripShape;
  /** REQ §13.93: source of truth when sent — `submit_request` derives `trip_shape`/`needs_car_at_destination`/`one_way_car_mode` from it. */
  trip_type?: TripType;
  /** REQ §13.93: explicit origin; omitted to let `submit_request` default to the requester's own `default_origin_id`, else the department home. */
  origin_id?: string;
  origin_text?: string;
  /**
   * REQ §13.93 "Multi-stop rides": replaces the request's whole stop set, in route order per
   * leg; the key must always be present on edit — its absence leaves existing stops untouched
   * (`submit_request`'s own convention, same as `notes`) — `mapper.ts` always sends it.
   */
  stops?: { leg: "out" | "return"; place_id?: string; place_text?: string }[];
  depart_at?: string;
  return_at?: string;
  adults: number;
  child_seats: number;
  boosters: number;
  has_luggage?: boolean;
  needs_car_at_destination?: boolean;
  one_way_car_mode?: LegCarMode;
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
  /** REQ §13.101 f (QM5): re-submit of an edit the server asked to confirm (`needs_confirmation`). */
  confirm_release?: boolean;
  /** R2B20 / REQ §102 f: ask the server what the edit would do without changing anything. */
  probe_only?: boolean;
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
  /**
   * REQ §13.101 f (QM5): an edit of a published/live-day request found no free car at the new
   * hours — nothing was changed; resubmit with `confirm_release: true` to release the current
   * ride and move the request to the waiting list. `drives_others`: the member drives others.
   */
  needs_confirmation?: "release_to_waitlist";
  drives_others?: boolean;
  /** With `needs_confirmation`: a car is free at the new hours — asked only because the member drives others. */
  would_place?: boolean;
  /** REQ §13.101 g (QM7): the member's own rides/requests overlapping the submitted one. */
  overlaps?: { request_id: string | null; ride_id: string | null }[];
  /** With `probe_only`: the edit would release the member's current car (R2B20). */
  would_lose_booking?: boolean;
}

/** `submit_request` with `probe_only: true` — changes nothing, reports `would_lose_booking`. */
export async function probeSubmitRequest(payload: SubmitRequestPayload): Promise<SubmitRequestResult | null> {
  const raw = await rpc("submit_request", { payload: { ...payload, probe_only: true } as unknown as Json });
  return raw as unknown as SubmitRequestResult | null;
}

export interface ChildOverlapRow {
  requestId: string;
  requesterName: string;
  childName: string;
  departAt: string;
  returnAt: string;
}

/** R2M4: named children of this request that are already on another member's overlapping request. */
export async function fetchChildRequestOverlaps(args: {
  departmentId: string;
  childNames: string[];
  departAt: string;
  returnAt: string;
  excludeRequestId?: string;
}): Promise<ChildOverlapRow[]> {
  const rows = await rpc("child_request_overlaps", {
    p_department_id: args.departmentId,
    p_child_names: args.childNames,
    p_depart_at: args.departAt,
    p_return_at: args.returnAt,
    ...(args.excludeRequestId ? { p_exclude_request_id: args.excludeRequestId } : {}),
  });
  return (rows ?? []).map((r) => ({
    requestId: r.request_id,
    requesterName: r.requester_name,
    childName: r.child_name,
    departAt: r.depart_at,
    returnAt: r.return_at,
  }));
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

/**
 * `joinable_rides_for_request(request_id)` (F4, docs/TODO.md, owner answers A8-A10): existing
 * rides the same day, within the department's `join_radius_km`, offered right after a
 * `waitlisted` outcome instead of just leaving the member to wait — see `JoinableRidesDialog`.
 * Purely a read: never called by `submitRequest`/`submitSeriesRequest` itself, so it can never
 * change placement. Empty for a free-text request, an open/solving week, or when nothing
 * nearby has a free seat that day — the caller treats an empty array as "nothing to offer".
 */
export interface JoinableRideRow {
  rideId: string;
  startsAt: string;
  endsAt: string;
  carName: string;
  carType: CarType;
  destinationName: string;
  /** Empty when the ride has no assigned driver yet. */
  driverName: string;
  distanceKm: number;
  freeSeats: number;
  /**
   * `profiles.phone`, null when the driver has none or the ride has no driver yet (REQ §10
   * amendment, 2026-09-14: department members' phones are not secrets — `JoinableRidesDialog`
   * uses this for a WhatsApp quick link alongside the in-app "ask to join" button).
   */
  driverPhone: string | null;
}

export async function fetchJoinableRides(requestId: string): Promise<JoinableRideRow[]> {
  const rows = await rpc("joinable_rides_for_request", { p_request_id: requestId });
  return (rows ?? []).map((row) => {
    const parsed = joinableRideRowSchema.parse(row);
    return {
      rideId: parsed.ride_id,
      startsAt: parsed.starts_at,
      endsAt: parsed.ends_at,
      carName: parsed.car_name,
      carType: parsed.car_type,
      destinationName: parsed.destination_name,
      driverName: parsed.driver_name,
      distanceKm: parsed.distance_km,
      freeSeats: parsed.free_seats,
      driverPhone: parsed.driver_phone,
    };
  });
}

export async function withdrawRequest(requestId: string, expectedVersion: number): Promise<void> {
  await rpc("withdraw_request", { p_request_id: requestId, p_expected_version: expectedVersion });
}

/** REQ §13.103 c: shorten the caller's own multi-day request to a consecutive sub-span. */
export async function shortenSeries(requestId: string, departAt: string, returnAt: string): Promise<void> {
  await rpc("shorten_series", { p_request_id: requestId, p_depart_at: departAt, p_return_at: returnAt });
}

/**
 * `requests.version` right now — used right before `withdrawRequest()` when the caller
 * (`JoinableRidesDialog`'s "join now" flow, `RequestForm.tsx`) doesn't already hold a
 * known-fresh version: `submit_request`'s own result carries no `version` field, and by the
 * time the member picks a joinable ride the request may already be a moment old.
 */
export async function fetchRequestVersion(requestId: string): Promise<number | null> {
  const { data, error } = await supabase.from("requests").select("version").eq("id", requestId).maybeSingle();
  if (error) throw toAppError(error);
  return data?.version ?? null;
}

/** REQ §13.101 h (QM8): the requester puts an unserved round-trip request on their own private (temporary) car. */
export async function placeOnOwnCar(requestId: string, carId: string): Promise<void> {
  await rpc("place_on_own_car", { p_request_id: requestId, p_car_id: carId });
}

/** REQ §13.101 e (QM4): "this is not a duplicate" — restores a request the Sadran withdrew as one. */
export async function restoreDuplicateRequest(requestId: string): Promise<void> {
  await rpc("restore_duplicate_request", { p_request_id: requestId });
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
  claimStatus: FreedClaimStatus;
  offerStatus: FreedOfferStatus;
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
         cancelled_ride:rides!freed_slot_offers_cancelled_ride_id_fkey(destination:destinations!rides_destination_id_fkey(name)))`,
    )
    .eq("profile_id", profileId)
    .order("offered_at", { ascending: false });
  if (error) throw toAppError(error);

  interface Raw {
    status: FreedClaimStatus;
    request_id: string;
    offer: {
      id: string;
      status: FreedOfferStatus;
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
  await rpc("set_request_companions", { p_request_id: requestId, p_profile_ids: profileIds });
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
  /** REQ §13.93: copied by `save_request_template`, read by `v_request_template_suggestions`. */
  originId: string | null;
  originText: string | null;
  originName: string | null;
  /** REQ §13.93 "Multi-stop rides": `request_templates.stops`, `eta` always null (prefill only). */
  stops: RouteStop[];
  tripType: TripType;
  departDow: number | null;
  departTime: string | null;
  returnDow: number | null;
  returnTime: string | null;
  /** Already anchored to `weekStart` (computed in SQL from `departDow`/`departTime`). */
  departAt: string | null;
  returnAt: string | null;
  oneWayCarMode: LegCarMode | null;
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
    originId: row.origin_id,
    originText: row.origin_text,
    originName: row.origin_name,
    stops: parseRouteStops(row.stops),
    tripType: row.trip_type,
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
  ride_type_id, ride_type_name, trip_shape, origin_id, origin_text, origin_name, trip_type,
  depart_dow, depart_time, return_dow, return_time,
  depart_at, return_at, one_way_car_mode, needs_car_at_destination, adults, child_seats, boosters,
  child_ids, companion_ids, has_luggage, flex_depart_early, flex_depart_late, flex_return_early,
  flex_return_late, preferred_car_id, ride_description, guest_passenger_names, notes, stops
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

export interface ChildOption {
  id: string;
  name: string;
  birthYear: number | null;
  age: number | null;
  isAdultPassenger: boolean;
  /** A child assigned to the signed-in member is shown first, not forced. */
  isPriority: boolean;
}

export async function fetchChildren(departmentId: string, profileId: string, referenceYear = new Date().getFullYear()): Promise<ChildOption[]> {
  const [{ data: children, error: childrenError }, { data: guardians, error: guardiansError }] = await Promise.all([
    supabase.from("children").select("id, full_name, birth_year").eq("department_id", departmentId).order("full_name"),
    supabase.from("child_guardians").select("child_id").eq("profile_id", profileId),
  ]);
  if (childrenError) throw toAppError(childrenError);
  if (guardiansError) throw toAppError(guardiansError);
  const priority = new Set((guardians ?? []).map((guardian) => guardian.child_id));
  return (children ?? [])
    .map((child) => ({
      id: child.id,
      name: child.full_name,
      birthYear: child.birth_year,
      age: ageFromBirthYear(child.birth_year, referenceYear),
      isAdultPassenger: isAdultPassenger(child.birth_year, referenceYear),
      isPriority: priority.has(child.id),
    }))
    .sort((a, b) => Number(b.isPriority) - Number(a.isPriority) || a.name.localeCompare(b.name, "he"));
}
