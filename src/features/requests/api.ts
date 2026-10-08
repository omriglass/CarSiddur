import { supabase } from "@/integrations/supabase/client";
import { ageFromBirthYear, isAdultPassenger } from "@/lib/childAge";
import { isActiveStop, parseRouteStops, type RouteStop } from "@/lib/routeStops";
import { rpc, toAppError } from "@/lib/rpc";
import { withSmallTrunkRetry } from "@/lib/smallTrunk";
import { siddurCarName } from "@/lib/siddurCarName";

import { splitMemberProposals } from "./pendingProposal";
import { extraAdultsFromStored, unnamedChildSeatsFromStored } from "./seatCounts";
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
  RequestFallbackValue,
  RequestStatus,
  RideLeg,
  RideRole,
  RideStatus,
  TimeAnchor,
  TripShape,
  TripType,
} from "@/lib/enums";
import { isHiddenOutcome, isRequestDayPublished, type PlacedLeg } from "./publishedOutcome";
import type { StoredAlternative } from "./planB";
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

/** `request_alternatives` of a request as `/my` shows it (instants as ISO strings; `originalMain` = the replaced main trip once plan B was applied). */
export interface MyRequestAlternative extends StoredAlternative {
  originalMain: Json | null;
}

export interface MyRequestRow {
  preferredCarId?: string | null;
  preferredCarName?: string | null;
  hasPublishedRide?: boolean;
  window?: RequestWindow | null;
  hasLuggage?: boolean;
  /** REQ §13.111 (a): the large-trunk requirement was waived by whoever placed the request by hand (`requests.luggage_waived_at`). */
  luggageWaived?: boolean;
  /** Named children on this request (`request_children` → `children.full_name`), UX_FLOWS.md §4.2. */
  childNames?: string[];
  /** R11U2/R11F2: the other people on the request — member companions, named guests, unnamed adults/children — and the public description. */
  companionNames?: string[];
  guestNames?: string[];
  extraAdults?: number;
  unnamedChildren?: number;
  rideDescription?: string | null;
  /** REQ §13.110 (b): how each end was entered — drives "להגיע עד 09:30" / "יציאה מחיפה 13:00" (`enteredTimes.ts`). */
  departAnchor?: TimeAnchor | null;
  arriveBy?: string | null;
  returnAnchor?: TimeAnchor | null;
  leaveDestAt?: string | null;
  /** REQ §13.112 (c): "N hours between A and B" — shown as such (`timeWindow.ts` `windowSummary`); `flexReturnLate` is the window's slack. */
  durationLocked?: boolean;
  flexReturnLate?: string | null;
  /** REQ §13.112 (a)/(b): "אם אין רכב" — plan B / "אסתדר"; `servedByAlternative` = the request now IS its plan B (`fallbackLine.ts`). */
  fallback?: RequestFallbackValue;
  servedByAlternative?: boolean;
  alternative?: MyRequestAlternative | null;
  /** `requests.destination_id` (null for a free-text destination) — recent-destination chips. */
  destinationId?: string | null;
  destinationText?: string | null;
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
  /** Every live ride leg this request holds (empty before the day is published, REQ §13.109 a) — per-leg state and the member's own times. */
  legs?: PlacedLeg[];
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
  depart_at, return_at, trip_shape, needs_car_at_destination, destination_id, destination_text, version, ride_type_id,
  origin_id, origin_text, trip_type, depart_anchor, arrive_by, return_anchor, leave_dest_at,
  freed_slot_opt_out, has_luggage, luggage_waived_at, preferred_car_id, template_id, series_id, series_index, series_count,
  duration_locked, flex_return_late, fallback, served_by_alternative, plan_b_parent_id,
  alternative:request_alternatives(drop_place_id, drop_place_text, arrive_by, pickup, pickup_at, original_main, drop_place:destinations!request_alternatives_place_fk(name), pickup_place_id, pickup_place_text, pickup_place:destinations!request_alternatives_pickup_place_fk(name)),
  preferred_car:cars!requests_preferred_car_id_fkey(name),
  window:weeks(phase, open_at, close_at, published_days),
  destination:destinations!requests_destination_id_fkey(name),
  origin:destinations!requests_origin_id_fkey(name),
  stops:request_stops(leg, position, place_id, place_text, place:destinations(name)),
  ride_type:ride_types(code, name_he),
  ride_requests(
    role, leg,
    ride:rides(
      id, starts_at, ends_at, status, needs_driver, version,
      origin:destinations!rides_origin_id_fkey(name),
      destination:destinations!rides_destination_id_fkey(name),
      car:cars(name, type, codes:car_access_codes(access_code, is_replaced, replacement_code)),
      driver:profiles!rides_driver_id_fkey(full_name)
    )
  ),
  proposals(id, type, reason:payload->>reason, expires_at, status, parties:proposal_parties(profile_id, response)),
  adults, child_seats, boosters, guest_passenger_names, ride_description,
  companions:request_companions(profile:profiles(full_name)),
  request_children(child:children(full_name, birth_year))
`;

/** `request_alternatives(...)` embed: one row per request, so PostgREST returns an object (an array is tolerated). */
interface RawAlternative {
  drop_place_id: string | null;
  drop_place_text: string | null;
  arrive_by: string;
  pickup: boolean;
  pickup_at: string | null;
  original_main?: Json | null;
  drop_place?: { name: string } | null;
  /** Pickup from somewhere other than the drop place (both null = from the drop place). */
  pickup_place_id?: string | null;
  pickup_place_text?: string | null;
  pickup_place?: { name: string } | null;
}

function mapAlternative(raw: RawAlternative | RawAlternative[] | null | undefined): MyRequestAlternative | null {
  const alt = Array.isArray(raw) ? raw[0] : raw;
  if (!alt) return null;
  return {
    dropPlaceId: alt.drop_place_id,
    dropPlaceText: alt.drop_place_text,
    dropPlaceName: alt.drop_place?.name ?? alt.drop_place_text ?? null,
    arriveBy: alt.arrive_by,
    pickup: alt.pickup,
    pickupAt: alt.pickup_at,
    pickupPlaceId: alt.pickup_place_id ?? null,
    pickupPlaceText: alt.pickup_place_text ?? null,
    pickupPlaceName: alt.pickup_place?.name ?? alt.pickup_place_text ?? null,
    originalMain: alt.original_main ?? null,
  };
}

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
  destination_id?: string | null;
  destination_text: string | null;
  depart_anchor?: TimeAnchor | null;
  arrive_by?: string | null;
  return_anchor?: TimeAnchor | null;
  leave_dest_at?: string | null;
  duration_locked?: boolean;
  flex_return_late?: string | null;
  fallback?: RequestFallbackValue;
  served_by_alternative?: boolean;
  /** The sibling request an accepted plan B with another pickup place creates; shown inside its parent, never as an item. */
  plan_b_parent_id?: string | null;
  alternative?: RawAlternative | RawAlternative[] | null;
  version: number;
  freed_slot_opt_out: boolean;
  has_luggage: boolean | null;
  luggage_waived_at?: string | null;
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
    leg: RideLeg;
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
    reason: string | null;
    expires_at: string | null;
    status: ProposalStatus;
    parties: { profile_id: string; response: "pending" | "accepted" | "declined" }[] | null;
  }[];
  request_children: { child: { full_name: string; birth_year: number | null } | null }[];
  adults?: number;
  child_seats?: number;
  boosters?: number;
  guest_passenger_names?: string[] | null;
  ride_description?: string | null;
  companions?: { profile: { full_name: string } | null }[] | null;
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

/** R11U2: who else is on the request — named companions/guests and the unnamed remainder of the stored seat counts. */
function mapOtherPeople(row: RawRequestRow): Pick<MyRequestRow, "companionNames" | "guestNames" | "extraAdults" | "unnamedChildren"> {
  const companionNames = (row.companions ?? []).flatMap((entry) => entry.profile?.full_name ? [entry.profile.full_name] : []);
  const guestNames = row.guest_passenger_names ?? [];
  const year = Number((row.depart_at ?? row.return_at ?? row.week_start).slice(0, 4));
  const linked = row.request_children.flatMap((entry) => (entry.child ? [entry.child] : []));
  const adultChildren = linked.filter((child) => isAdultPassenger(child.birth_year, year)).length;
  return {
    companionNames,
    guestNames,
    extraAdults: extraAdultsFromStored({ storedAdults: row.adults ?? 1, companionsCount: (row.companions ?? []).length, guestsCount: guestNames.length, adultChildrenCount: adultChildren }),
    unnamedChildren: unnamedChildSeatsFromStored({ storedChildSeats: row.child_seats ?? 0, seatChildrenCount: linked.length - adultChildren }) + (row.boosters ?? 0),
  };
}

function mapRow(row: RawRequestRow, profileId?: string): MyRequestRow {
  // REQ §13.109 (a): outcomes (status, reason, ride, legs) exist for the member only on published days.
  const published = isRequestDayPublished(row.window, row.depart_at, row.return_at);
  const liveLinks = published ? row.ride_requests : [];
  const hidden = isHiddenOutcome(row.status, published);
  const legWithRide = liveLinks.find((leg) => leg.ride !== null && leg.ride.status !== "cancelled");
  const ride = legWithRide?.ride ?? null;
  const legs: PlacedLeg[] = liveLinks.flatMap((link) =>
    link.ride && link.ride.status !== "cancelled"
      ? [{ leg: link.leg, startsAt: link.ride.starts_at, endsAt: link.ride.ends_at }]
      : []);
  // R5B9: a sent proposal the member has already answered (it still waits for the other parties) is no longer "waiting for your answer".
  const { pending: pendingProposal, answeredWaiting } = splitMemberProposals(row.proposals, profileId);

  return {
    preferredCarId: row.preferred_car_id,
    preferredCarName: row.preferred_car?.name ?? null,
    window: row.window,
    hasLuggage: row.has_luggage ?? false,
    luggageWaived: !!row.has_luggage && !!row.luggage_waived_at,
    hasPublishedRide: row.ride_requests.some((link) => link.ride && link.ride.status !== "cancelled" && link.ride.status !== "draft"),
    childNames: row.request_children.flatMap((entry) => entry.child?.full_name ? [entry.child.full_name] : []),
    ...mapOtherPeople(row),
    rideDescription: row.ride_description?.trim() || null,
    departAnchor: row.depart_anchor ?? null,
    arriveBy: row.arrive_by ?? null,
    returnAnchor: row.return_anchor ?? null,
    leaveDestAt: row.leave_dest_at ?? null,
    durationLocked: row.duration_locked ?? false,
    flexReturnLate: row.flex_return_late ?? null,
    fallback: row.fallback ?? "none",
    servedByAlternative: row.served_by_alternative ?? false,
    alternative: mapAlternative(row.alternative),
    destinationId: row.destination_id ?? null,
    destinationText: row.destination_text,
    id: row.id,
    departmentId: row.department_id,
    weekStart: row.week_start,
    status: hidden ? "submitted" : row.status,
    statusReason: hidden ? null : row.status_reason,
    legs,
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
          reasonHe: pendingProposal.reason?.trim() ?? "",
          expiresAt: pendingProposal.expires_at,
        }
      : null,
    acceptedAwaitingOthers: !pendingProposal && (answeredWaiting || row.proposals.some((p) => p.status === "accepted")),
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
  /** REQ §13.110 (b): how each end was entered (defaults leave / arrive on a pre-anchor row). */
  departAnchor: TimeAnchor;
  arriveBy: string | null;
  returnAnchor: TimeAnchor;
  leaveDestAt: string | null;
  /** REQ §13.112 (c): a window request ("N hours between A and B"); opens in window mode on edit. */
  durationLocked: boolean;
  /** REQ §13.112 (a)/(b): the stored fallback + plan B; a request served by its plan B is not editable. */
  fallback: RequestFallbackValue;
  servedByAlternative: boolean;
  alternative: StoredAlternative | null;
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
  origin_id, origin_text, trip_type, depart_anchor, arrive_by, return_anchor, leave_dest_at, duration_locked,
  fallback, served_by_alternative, plan_b_parent_id,
  alternative:request_alternatives(drop_place_id, drop_place_text, arrive_by, pickup, pickup_at, drop_place:destinations!request_alternatives_place_fk(name), pickup_place_id, pickup_place_text, pickup_place:destinations!request_alternatives_pickup_place_fk(name)),
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
    depart_anchor: TimeAnchor | null;
    arrive_by: string | null;
    return_anchor: TimeAnchor | null;
    leave_dest_at: string | null;
    duration_locked: boolean | null;
    fallback?: RequestFallbackValue | null;
    served_by_alternative?: boolean | null;
    alternative?: RawAlternative | RawAlternative[] | null;
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
    departAnchor: row.depart_anchor ?? "leave",
    arriveBy: row.arrive_by ?? null,
    returnAnchor: row.return_anchor ?? "arrive",
    leaveDestAt: row.leave_dest_at ?? null,
    durationLocked: row.duration_locked ?? false,
    fallback: row.fallback ?? "none",
    servedByAlternative: row.served_by_alternative ?? false,
    alternative: mapAlternative(row.alternative),
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
    .filter((row) => !row.plan_b_parent_id)
    .filter((row) => !["withdrawn", "cancelled"].includes(row.status) || isDuplicateWithdrawn(row))
    .map((row) => mapRow(row, profileId));
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
  /**
   * REQ §13.110 (b), sentence layout only: how each end was entered. `arrive_by` is set iff
   * `depart_anchor = 'arrive'`, `leave_dest_at` iff `return_anchor = 'leave'` (explicit `null`
   * clears); `depart_at`/`return_at` are the derived car times. Absent = the server keeps and
   * shifts the stored anchors (the classic form never sends them).
   */
  depart_anchor?: TimeAnchor;
  arrive_by?: string | null;
  return_anchor?: TimeAnchor;
  leave_dest_at?: string | null;
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
  /** REQ §13.112 (c): "N hours somewhere in a window" — the stored block keeps its length (sentence layout only; absent = keep). */
  duration_locked?: boolean;
  /**
   * REQ §13.112 (a)/(b), weekly sentence layout, single-day הלוך-חזור / הלוך בלבד only (`mapper.ts` `fallbackPayload`):
   * absent = the server keeps what is stored; `alternative: null` removes a stored plan B.
   */
  fallback?: RequestFallbackValue;
  alternative?: {
    drop_place_id?: string;
    drop_place_text?: string;
    arrive_by: string;
    pickup: boolean;
    pickup_at: string | null;
    /** Absent = pickup from the drop place; only with `pickup: true`. */
    pickup_place_id?: string;
    pickup_place_text?: string;
  } | null;
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
  /** REQ §13.111 (a): quick / car-now - ask "לשבץ בכל זאת?" when only a car without a large trunk could take a large-luggage request. */
  ask_small_trunk?: boolean;
  /** REQ §13.111 (a): the member confirmed it (set by the retry in `submitRequest`, never by a form). */
  allow_small_trunk?: boolean;
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
  /** R11B1: an edit that changes nothing (also on the probe) — the server touched nothing and asks nothing. */
  unchanged?: boolean;
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
  // REQ §13.111 (a): `needs_large_trunk` (quick / car-now, ask-to-join) asks the shared dialog and retries with the flag.
  return withSmallTrunkRetry((allowSmallTrunk) => rpc("submit_request", {
    payload: (allowSmallTrunk ? { ...payload, allow_small_trunk: true } : payload) as unknown as Json,
  }));
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
  // REQ §13.111 (a): the owner's own car has no large trunk for a large-luggage request - ask "לשבץ בכל זאת?", then retry with the flag.
  await withSmallTrunkRetry((allowSmallTrunk) => rpc("place_on_own_car", { p_request_id: requestId, p_car_id: carId, p_allow_small_trunk: allowSmallTrunk }));
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

/** Companions on the member's own requests (RLS-scoped), for the who-sheet's "recent" chips. */
export async function fetchRecentCompanionRows(profileId: string): Promise<{ profileId: string; at: string | null }[]> {
  const { data, error } = await supabase
    .from("request_companions")
    .select("profile_id, request:requests!inner(requester_id, depart_at, return_at)")
    .eq("request.requester_id", profileId)
    .limit(80);
  if (error) throw toAppError(error);
  const rows = (data ?? []) as unknown as { profile_id: string; request: { depart_at: string | null; return_at: string | null } | null }[];
  return rows.map((row) => ({ profileId: row.profile_id, at: row.request?.depart_at ?? row.request?.return_at ?? null }));
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
  /** REQ §13.110 (b): carried from the template's source request. */
  departAnchor?: TimeAnchor;
  arriveBy?: string | null;
  returnAnchor?: TimeAnchor;
  leaveDestAt?: string | null;
  /** REQ §13.112 (c): the template's source was a window request. */
  durationLocked?: boolean;
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
    departAnchor: row.depart_anchor ?? "leave",
    arriveBy: row.arrive_by ?? null,
    returnAnchor: row.return_anchor ?? "arrive",
    leaveDestAt: row.leave_dest_at ?? null,
    durationLocked: row.duration_locked ?? false,
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
  depart_at, return_at, depart_anchor, arrive_by, return_anchor, leave_dest_at, one_way_car_mode, needs_car_at_destination, adults, child_seats, boosters,
  child_ids, companion_ids, has_luggage, flex_depart_early, flex_depart_late, flex_return_early,
  flex_return_late, duration_locked, preferred_car_id, ride_description, guest_passenger_names, notes, stops
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

/** One point of a `route_minutes_preview` route: a list place or free text. */
export interface RoutePreviewPoint {
  place_id: string | null;
  place_text: string | null;
}

/**
 * REQ §13.110 (b): route minutes of an unsaved request leg (`route_minutes_preview`, DATA_MODEL
 * §7) — origin, stops..., destination (the return leg passes destination, return stops..., origin).
 */
export async function fetchRouteMinutesPreview(departmentId: string, points: readonly RoutePreviewPoint[]): Promise<number> {
  return rpc("route_minutes_preview", { p_department_id: departmentId, p_points: points as unknown as Json });
}
