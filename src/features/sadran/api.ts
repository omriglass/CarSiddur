import { ensureDepartmentWeeks } from "@/features/siddur/api";
import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database, Json } from "@/integrations/supabase/types";
import type { LegCarMode, NotificationChannel, ProposalType, RideLeg, RideRole, TripType } from "@/lib/enums";

/**
 * The only file in the `sadran` feature that calls `supabase.from`/`.rpc`
 * (ui-dev.md "Structure"). Covers every screen (dashboard, board, proposal
 * composer, contested claims, publish, change log) since they all share the
 * same `(departmentId, weekStart)` scope and many of the same tables.
 */
export type WeekRow = Database["public"]["Tables"]["weeks"]["Row"];
export type RequestRow = Database["public"]["Tables"]["requests"]["Row"];
export type DepartmentSettingsRow = Database["public"]["Tables"]["department_settings"]["Row"];
export type MaintenanceBlockRow = Database["public"]["Tables"]["car_maintenance_blocks"]["Row"];
export type SolverRunRow = Database["public"]["Tables"]["solver_runs"]["Row"];
export type ProposalRow = Database["public"]["Tables"]["proposals"]["Row"];
export type ProposalPartyRow = Database["public"]["Tables"]["proposal_parties"]["Row"];
export type FreedSlotOfferRow = Database["public"]["Tables"]["freed_slot_offers"]["Row"];
export type FreedSlotClaimRow = Database["public"]["Tables"]["freed_slot_claims"]["Row"];
export type SiddurVersionRow = Database["public"]["Tables"]["siddur_versions"]["Row"];
export type AuditLogRow = Database["public"]["Tables"]["audit_log"]["Row"];
export type NotificationTemplateRow = Database["public"]["Tables"]["notification_templates"]["Row"];
export type PolicyRow = Database["public"]["Tables"]["policies"]["Row"];
export type PolicyVersionRow = Database["public"]["Tables"]["policy_versions"]["Row"];
export type BoardRide = Database["public"]["Views"]["v_board_rides"]["Row"];

/**
 * `requests` plus the joined names the board/dashboard need to show *which*
 * request is unmet (owner bug report #1: the unmet list/counters must be
 * usable without a solver run, straight from persisted data) — embedded via
 * PostgREST's FK-embed syntax rather than a new view/migration, since every
 * relationship already exists (`requests.requester_id -> profiles`,
 * `.destination_id -> destinations`, `.ride_type_id -> ride_types`) and RLS
 * on the joined tables already allows a signed-in Sadran to read them (the
 * same tables `v_board_rides`/`fetchProfilesByIds`/`fetchRideTypes` already
 * join/select). `requests` has two FKs to `profiles` (`requester_id`,
 * `filed_by`), so the embed must name the constraint explicitly
 * (`!requests_requester_id_fkey`) — same convention as
 * `features/requests/api.ts`'s `EDIT_SELECT`. Also embeds `request_children`
 * → `children.full_name` (child-display bugfix) so the unmet list can show
 * a child's actual name instead of always falling back to
 * `he.ridePublicDetails.unnamedChild`; RLS on `request_children` already
 * allows this for a Sadran/admin managing the week (`can_manage_week`), the
 * same condition this function is used under.
 */
export interface WeekRequestRow extends RequestRow {
  companions?: { profile_id: string; name: string }[];
  /** Named children (`request_children` → `children.full_name`), distinct from the guessed "unnamed child" fallback (`he.ridePublicDetails.unnamedChild`). */
  childNames?: string[];
  requester_full_name: string | null;
  /** REQ §88 (owner 2026-09-15): `profiles.does_not_drive` for the requester. */
  requester_does_not_drive: boolean;
  /** REQ §13.88 (owner 2026-09-16, E1): ids of named companions (`request_companions`) who are eligible drivers. */
  driving_companion_ids: string[];
  destination_resolved_name: string | null;
  destination_travel_minutes: number | null;
  ride_type_code: string | null;
  ride_type_name_he: string | null;
  /** Quick-request-from-empty-slot (UX_FLOWS.md §18) — the car the member asked for, if any. */
  preferred_car_name: string | null;
  /** REQUIREMENTS §13.93: resolved origin name (list place) — `null` leaves `origin_text` (free text) as the only label. */
  origin_resolved_name: string | null;
  /**
   * REQUIREMENTS §13.93 "Multi-stop rides": raw `request_stops` rows — the unmet card's "דרך: …"
   * line (`UnmetList.tsx`, names) and the solver-bridge feeder (`buildSolverInput.ts`). No `active`
   * column on the table: use `isActiveStop(stop, request.return_at != null)`.
   */
  stops: { leg: "out" | "return"; position: number; active?: boolean; place_id: string | null; place_text?: string | null; place?: { name: string } | null }[];
}

const WEEK_REQUEST_SELECT = `*,
  requester:profiles!requests_requester_id_fkey(full_name, does_not_drive),
  destination:destinations!requests_destination_id_fkey(name, travel_minutes),
  origin:destinations!requests_origin_id_fkey(name),
  ride_type:ride_types(code, name_he),
  preferred_car:cars!requests_preferred_car_id_fkey(name),
  companions:request_companions(profile_id, profile:profiles!request_companions_profile_id_fkey(full_name, does_not_drive)),
  request_children(child:children(full_name)),
  stops:request_stops(leg, position, place_id, place_text, place:destinations(name))`;

interface WeekRequestJoinRow extends RequestRow {
  companions: { profile_id: string; profile: { full_name: string; does_not_drive: boolean } | null }[];
  request_children: { child: { full_name: string } | null }[];
  requester: { full_name: string; does_not_drive: boolean } | null;
  destination: { name: string; travel_minutes: number | null } | null;
  origin: { name: string } | null;
  ride_type: { code: string; name_he: string } | null;
  preferred_car: { name: string } | null;
  stops: { leg: "out" | "return"; position: number; active?: boolean; place_id: string | null; place_text?: string | null; place?: { name: string } | null }[];
}

/** Ids of `companions` whose profile is an eligible driver (`!does_not_drive`), REQ §13.88. */
function drivingCompanionIdsOf(companions: { profile_id: string; profile: { does_not_drive: boolean } | null }[]): string[] {
  return companions.flatMap((person) => person.profile && !person.profile.does_not_drive ? [person.profile_id] : []);
}

function flattenWeekRequest(row: WeekRequestJoinRow): WeekRequestRow {
  const { requester, destination, origin, ride_type, preferred_car, companions, request_children, ...rest } = row;
  return {
    ...rest,
    requester_full_name: requester?.full_name ?? null,
    /** REQ §88: `Request.canDrive = !requester.does_not_drive` (solverBridge/buildSolverInput.ts). */
    requester_does_not_drive: requester?.does_not_drive ?? false,
    /** REQ §13.88 (owner 2026-09-16, E1): -> solver `Request.drivingCompanionIds`. */
    driving_companion_ids: drivingCompanionIdsOf(companions ?? []),
    companions: (companions ?? []).flatMap((person) => person.profile ? [{ profile_id: person.profile_id, name: person.profile.full_name }] : []),
    childNames: (request_children ?? []).flatMap((entry) => entry.child?.full_name ? [entry.child.full_name] : []),
    destination_resolved_name: destination?.name ?? rest.destination_text ?? null,
    destination_travel_minutes: destination?.travel_minutes ?? null,
    ride_type_code: ride_type?.code ?? null,
    ride_type_name_he: ride_type?.name_he ?? null,
    preferred_car_name: preferred_car?.name ?? null,
    origin_resolved_name: origin?.name ?? rest.origin_text ?? null,
  } as WeekRequestRow;
}

// ---------------------------------------------------------------------------
// Week / phase overrides
// ---------------------------------------------------------------------------

export async function fetchWeekRow(departmentId: string, weekStart: string): Promise<WeekRow | null> {
  await ensureDepartmentWeeks(departmentId);
  const { data, error } = await supabase
    .from("weeks")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw toAppError(error);
  return data;
}

// ---------------------------------------------------------------------------
// Requests / board reads (rides come from `v_board_rides`, RLS already scopes
// drafts to the Sadran/driver only — supabase/migrations/20260907091400_rls.sql
// `rides_select` — so this is safe to reuse from a signed-in Sadran session)
// ---------------------------------------------------------------------------

/**
 * Solver-bridge feeder (`buildSolverInput`'s `requests` param, `applySolve.ts`): plain
 * `requests` columns plus the two extra fields the solver needs from `profiles`/
 * `request_companions` — `requester_does_not_drive` (REQ §88 — `Request.canDrive =
 * !requester.does_not_drive`) and `driving_companion_ids` (REQ §13.88, owner 2026-09-16, E1 —
 * ids of this request's named companions who are eligible drivers, mapped straight onto
 * `Request.drivingCompanionIds`). Kept as a light embed (just the two ids/flags it needs)
 * rather than `WEEK_REQUEST_SELECT`'s full join set (names/destinations/children) since this
 * runs on every solve.
 */
export type RequestRowWithDriverFlag = RequestRow & {
  requester_does_not_drive: boolean;
  /** Names merge hosts in the solver's reasons (`buildSolverInput` maps it onto `Request.memberName`). */
  requester_full_name: string | null;
  driving_companion_ids: string[];
  /** REQUIREMENTS §13.93 "Multi-stop rides": -> `buildSolverInput`'s `Request.stops`. */
  stops?: { leg: "out" | "return"; position: number; active?: boolean; place_id: string | null }[];
};

export async function fetchWeekRequests(departmentId: string, weekStart: string): Promise<RequestRowWithDriverFlag[]> {
  const { data, error } = await supabase
    .from("requests")
    .select(`*,
      requester:profiles!requests_requester_id_fkey(full_name, does_not_drive),
      companions:request_companions(profile_id, profile:profiles!request_companions_profile_id_fkey(does_not_drive)),
      stops:request_stops(leg, position, place_id, place_text, place:destinations(name))`)
    .eq("department_id", departmentId)
    .eq("week_start", weekStart);
  if (error) throw toAppError(error);
  return ((data ?? []) as unknown as (RequestRow & {
    requester: { full_name: string; does_not_drive: boolean } | null;
    companions: { profile_id: string; profile: { does_not_drive: boolean } | null }[];
    stops: { leg: "out" | "return"; position: number; active?: boolean; place_id: string | null; place_text?: string | null; place?: { name: string } | null }[];
  })[]).map(
    ({ requester, companions, ...rest }) => ({
      ...rest,
      requester_does_not_drive: requester?.does_not_drive ?? false,
      requester_full_name: requester?.full_name ?? null,
      driving_companion_ids: drivingCompanionIdsOf(companions ?? []),
    }),
  );
}

/**
 * Same rows as `fetchWeekRequests`, plus the requester/destination/ride-type
 * names the board's `UnmetList` and the dashboard's counters need (bug #1) —
 * a separate function (rather than changing `fetchWeekRequests` itself)
 * because `solverRun.ts#gatherSolverContext` only needs the plain columns
 * `buildSolverInput` maps and re-fetching with joins there would be wasted
 * work on every solve.
 */
export async function fetchWeekRequestsWithNames(
  departmentId: string,
  weekStart: string,
): Promise<WeekRequestRow[]> {
  const { data, error } = await supabase
    .from("requests")
    .select(WEEK_REQUEST_SELECT)
    .eq("department_id", departmentId)
    .eq("week_start", weekStart);
  if (error) throw toAppError(error);
  return ((data ?? []) as unknown as WeekRequestJoinRow[]).map(flattenWeekRequest);
}

// ---------------------------------------------------------------------------
// Department settings / maintenance blocks / policy (for `buildSolverInput`)
// ---------------------------------------------------------------------------

export async function fetchDepartmentSettings(departmentId: string): Promise<DepartmentSettingsRow> {
  const { data, error } = await supabase
    .from("department_settings")
    .select("*")
    .eq("department_id", departmentId)
    .single();
  if (error) throw toAppError(error);
  return data;
}

export async function fetchMaintenanceBlocksForDepartment(departmentId: string): Promise<MaintenanceBlockRow[]> {
  const { data, error } = await supabase
    .from("car_maintenance_blocks")
    .select("*")
    .eq("department_id", departmentId);
  if (error) throw toAppError(error);
  return data ?? [];
}

export interface ActivePolicy {
  policyId: string;
  name: string;
  policyVersionId: string;
  versionNo: number;
  rules: unknown;
  /** `policy_versions.settings` (owner, 2026-09-14; SOLVER.md §3.6/§3.6.2, REQ §13.84) — `{ carChoice?: 'pack' | 'spread' }`, absent/`{}` = spread. */
  settings: unknown;
}

interface ActivePolicyJoinRow {
  id: string;
  name: string;
  current_version_id: string | null;
  current_version: PolicyVersionRow | PolicyVersionRow[] | null;
}

/**
 * The selected department's active policy. One request via a PostgREST FK
 * embed (`policies.current_version_id -> policy_versions.id`, constraint
 * `policies_current_version_fk`) instead of the policy row then its version
 * as two sequential round trips (docs/HARDENING_2026-09.md §3 item 3).
 */
export async function fetchActivePolicy(departmentId: string): Promise<ActivePolicy | null> {
  const { data, error } = await supabase
    .from("policies")
    .select("id, name, current_version_id, current_version:policy_versions!policies_current_version_fk(*)")
    .eq("department_id", departmentId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw toAppError(error);

  const policyRow = data as unknown as ActivePolicyJoinRow | null;
  const version = Array.isArray(policyRow?.current_version) ? policyRow?.current_version[0] : policyRow?.current_version;
  if (!policyRow?.current_version_id || !version) return null;

  return {
    policyId: policyRow.id,
    name: policyRow.name,
    policyVersionId: version.id,
    versionNo: version.version_no,
    rules: version.rules,
    settings: version.settings,
  };
}

export interface PolicyOption {
  policyId: string;
  name: string;
  policyVersionId: string;
  versionNo: number;
  rules: unknown;
  isActive: boolean;
  /** `policy_versions.note` (board policy-versions dialog, UX_FLOWS.md §4.2) — free text, may be empty. */
  note: string | null;
  /** `policy_versions.created_at`, Asia/Jerusalem-formatted by the caller (`src/lib/time.ts`). */
  createdAt: string;
  /** `policy_versions.settings` (owner, 2026-09-14; SOLVER.md §3.6/§3.6.2, REQ §13.84). */
  settings: unknown;
}

/** Policies belonging to this department for the board switcher. */
export async function fetchPolicyOptions(departmentId: string): Promise<PolicyOption[]> {
  const { data: policies, error } = await supabase
    .from("policies")
    .select("id, name, current_version_id, is_active, department_id")
    .eq("department_id", departmentId);
  if (error) throw toAppError(error);

  const versionIds = (policies ?? []).map((p) => p.current_version_id).filter((id): id is string => !!id);
  if (versionIds.length === 0) return [];
  const { data: versions, error: versionsError } = await supabase
    .from("policy_versions")
    .select("*")
    .in("id", versionIds);
  if (versionsError) throw toAppError(versionsError);
  const versionById = new Map((versions ?? []).map((v) => [v.id, v]));

  return (policies ?? [])
    .filter((p) => p.current_version_id && versionById.has(p.current_version_id))
    .map((p) => {
      const version = versionById.get(p.current_version_id as string)!;
      return {
        policyId: p.id,
        name: p.name,
        policyVersionId: version.id,
        versionNo: version.version_no,
        rules: version.rules,
        isActive: p.is_active,
        note: version.note,
        createdAt: version.created_at,
        settings: version.settings,
      };
    });
}

export async function fetchFairnessStats(
  departmentId: string,
  weekStart: string,
  lookbackWeeks: number,
): Promise<Database["public"]["Functions"]["fairness_stats"]["Returns"]> {
  const { data, error } = await supabase.rpc("fairness_stats", {
    p_department_id: departmentId,
    p_week_start: weekStart,
    p_lookback_weeks: lookbackWeeks,
  });
  if (error) throw toAppError(error);
  return data ?? [];
}

/**
 * `car_mileage_totals()` (F5, docs/SOLVER.md §3.6.2): rolling-window km per
 * shared car, fed into `buildSolverInput`'s `mileageKmByCarId` so the solver
 * can prefer the less-driven car among otherwise-equally-acceptable ones.
 * The window is a fixed 4 weeks in v1 (no department setting, REQUIREMENTS
 * §13.84) — unlike `fairness_stats`, callable by any department member.
 */
export async function fetchCarMileageTotals(departmentId: string, weekStart: string): Promise<Record<string, number>> {
  const { data, error } = await supabase.rpc("car_mileage_totals", {
    p_department_id: departmentId,
    p_week_start: weekStart,
    p_weeks: 4,
  });
  if (error) throw toAppError(error);
  return Object.fromEntries((data ?? []).map((row) => [row.car_id, Number(row.km)]));
}

/**
 * `car_start_locations()` (REQUIREMENTS §13.93, docs/ORIGINS_PLAN_2026-10.md
 * §2 item 7): where each shared/temporary car is at week start — fed into
 * `buildSolverInput`'s `carStartLocationsByCarId` -> `Car.startLocationId`.
 * Keyed by `car_id`; a car left out of the map defaults to the department
 * home, as before this field existed.
 */
export async function fetchCarStartLocations(
  departmentId: string,
  weekStart: string,
): Promise<Record<string, { locationId: string; baseLocationId: string }>> {
  const rows = await rpc("car_start_locations", { p_department_id: departmentId, p_week_start: weekStart });
  return Object.fromEntries(
    (rows ?? []).map((row) => [row.car_id, { locationId: row.location_id, baseLocationId: row.base_location_id }]),
  );
}

/**
 * `place_travel_for_week()` (REQUIREMENTS §13.93, ORIGINS_PLAN §2 item 6):
 * every distinct (origin, destination) travel figure the week's requests
 * need beyond the home<->destination lookup already covered by
 * `destinations` rows — fed into `buildSolverInput`'s `travel` ->
 * `SolverInput.travel`, read only via the solver's own `travelBetween()`.
 */
export async function fetchPlaceTravelForWeek(
  departmentId: string,
  weekStart: string,
): Promise<{ fromId: string; toId: string; distanceKm?: number; travelMinutes?: number }[]> {
  const rows = await rpc("place_travel_for_week", { p_department_id: departmentId, p_week_start: weekStart });
  return (rows ?? []).map((row) => ({
    fromId: row.origin_id,
    toId: row.destination_id,
    distanceKm: row.distance_km ?? undefined,
    travelMinutes: row.travel_minutes ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// Solver runs (Run solver / record preview / apply draft)
// ---------------------------------------------------------------------------

export async function fetchLatestSolverRun(departmentId: string, weekStart: string): Promise<SolverRunRow | null> {
  const { data, error } = await supabase
    .from("solver_runs")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw toAppError(error);
  return data;
}

export async function recordSolverPreview(departmentId: string, weekStart: string, payload: Json): Promise<string> {
  return rpc("record_solver_preview", { p_department_id: departmentId, p_week_start: weekStart, p_payload: payload });
}

/**
 * `apply_solver_result`'s return shape changed from a bare run-id uuid to a
 * structured summary jsonb (bug-fix pass, `supabase/migrations/
 * 20260907093300_apply_solver_result_atomic_summary.sql`) so the caller can
 * show exactly what an apply did — never a silently partial result. See
 * `applySolve.ts`'s `ApplySolverResultSummary`.
 */
export interface ApplySolverResultResponse {
  run_id: string;
  inserted: number;
  deleted: number;
  unchanged: number;
  unassigned_requests: string[];
  /**
   * Multi-day requests ("series", REQ §13.77) this apply could not place on the car the
   * solver chose for the whole span — their legs return to `submitted`/`SERIES_CAR_
   * UNAVAILABLE`; the rest of the solve still applied (20260910093500_apply_solver_result_
   * series.sql).
   */
  skippedSeries?: { series_id: string; reason: string }[];
}

export async function applySolverResult(
  departmentId: string,
  weekStart: string,
  payload: Json,
): Promise<ApplySolverResultResponse> {
  const result = await rpc("apply_solver_result", {
    p_department_id: departmentId,
    p_week_start: weekStart,
    p_payload: payload,
  });
  return result as unknown as ApplySolverResultResponse;
}

// ---------------------------------------------------------------------------
// Single-ride edits (board drag/resize/reassign/pin/cancel, RideSheet)
// ---------------------------------------------------------------------------

export interface EditRideServedLeg {
  request_id: string;
  role: RideRole;
  leg?: RideLeg;
  car_mode: LegCarMode;
  detour_minutes?: number;
}

export interface EditRideInput {
  id?: string;
  department_id: string;
  week_start: string;
  car_id: string;
  starts_at: string;
  ends_at: string;
  origin_id: string;
  destination_id: string;
  driver_id: string | null;
  needs_driver?: boolean;
  allow_conflict?: boolean;
  notes?: string | null;
  overflow_allowed?: boolean;
  is_pinned?: boolean;
  pin_reason?: string | null;
  served?: EditRideServedLeg[];
}

export async function editRide(input: EditRideInput, expectedVersion?: number): Promise<string> {
  return rpc("edit_ride", { p_ride: input as unknown as Json, p_expected_version: expectedVersion });
}

export async function cancelRide(rideId: string, reason: string, expectedVersion?: number): Promise<void> {
  await rpc("cancel_ride", { p_ride_id: rideId, p_reason: reason, p_expected_version: expectedVersion });
}

export async function unassignRide(rideId: string, expectedVersion: number): Promise<void> {
  await rpc("unassign_ride", { p_ride_id: rideId, p_expected_version: expectedVersion });
}

/**
 * REQ §13.94 (G10): take an applied merge's added person back out of the ride (Sadran only): the
 * host window shrinks to its base route, the request returns to `submitted` (unmet) and the
 * person is notified. `p_expected_version` is the ride's.
 */
export async function unmergeRequest(rideId: string, requestId: string, expectedVersion: number): Promise<void> {
  await rpc("unmerge_request", { p_ride_id: rideId, p_request_id: requestId, p_expected_version: expectedVersion });
}

/**
 * REQ §13.95 (H3): the Sadran changes a request's trip type directly (`set_request_trip_type`).
 * `ride_id` is set when the request was re-placed on a ride (it stayed on the car); absent when it
 * went back to the unmet list. Errors: `trip_type_needs_return`, `non_driver_needs_drop_off`.
 */
export interface SetTripTypeResult {
  status: string;
  rideId: string | null;
  /** `false` when the request already had that trip type (nothing happened). */
  changed: boolean;
  /** The kept return time SQL put back when switching from one-way to a round trip (`restored_return_at`), if any. */
  restoredReturnAt: string | null;
  /** REQ §13.98: with no known return, SQL set one (~2h after arrival, flexible all day) — `defaulted_return_at`. */
  defaultedReturnAt: string | null;
}

export async function setRequestTripType(requestId: string, tripType: TripType, expectedVersion: number): Promise<SetTripTypeResult> {
  const raw = await rpc("set_request_trip_type", { p_request_id: requestId, p_trip_type: tripType, p_expected_version: expectedVersion });
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, Json | undefined>) : {};
  return { status: typeof body.status === "string" ? body.status : "", rideId: typeof body.ride_id === "string" ? body.ride_id : null, changed: body.changed !== false, restoredReturnAt: typeof body.restored_return_at === "string" ? body.restored_return_at : null,
    defaultedReturnAt: typeof body.defaulted_return_at === "string" ? body.defaulted_return_at : null };
}

/** One day (leg) of a multi-day request, as far as the Sadran's RLS lets this client see it. */
export interface SeriesLeg {
  id: string;
  seriesIndex: number;
  seriesCount: number;
  departAt: string;
  returnAt: string;
  status: string;
  version: number;
}

/** REQ §13.101 (j, QF5): every leg of a multi-day request, ordered by day (legs in weeks this client cannot read are absent). */
export async function fetchSeriesLegs(seriesId: string): Promise<SeriesLeg[]> {
  const { data, error } = await supabase
    .from("requests")
    .select("id, series_index, series_count, depart_at, return_at, status, version")
    .eq("series_id", seriesId)
    .order("depart_at", { ascending: true });
  if (error) throw toAppError(error);
  return (data ?? []).flatMap((row) => (row.depart_at && row.return_at ? [{
    id: row.id, seriesIndex: row.series_index ?? 1, seriesCount: row.series_count ?? 1,
    departAt: row.depart_at, returnAt: row.return_at, status: row.status, version: row.version,
  }] : []));
}

/** REQ §13.101 (c): assign a volunteer driver to a needs-driver ride, or (`driverId` null) take a volunteer off again. */
export async function setRideDriver(rideId: string, driverId: string | null, expectedVersion: number): Promise<void> {
  // The RPC accepts a null driver (back to needs-driver); the generated Args type marks it required.
  await rpc("set_ride_driver", { p_ride_id: rideId, p_driver_id: driverId as unknown as string, p_expected_version: expectedVersion });
}

/** REQ §13.101 (e): the Sadran withdraws a request as a duplicate; the member is notified and may answer "not a duplicate". */
export async function withdrawDuplicateRequest(requestId: string, expectedVersion: number): Promise<void> {
  await rpc("withdraw_duplicate_request", { p_request_id: requestId, p_expected_version: expectedVersion });
}

/**
 * A named person or child on a ride with no `requests` row behind them (F3,
 * 20260914120000_ride_passengers.sql). The reusable base for both the board reservation
 * dialog's optional people picker and the not-yet-built "+ נוסעים" button (docs/TODO.md).
 */
export interface RidePassengerInput {
  person_id?: string;
  child_id?: string;
  display_name: string;
  seat_kind: "adult" | "child_seat" | "booster";
}

/** Replaces a ride's named-passenger list in one transaction; see `set_ride_passengers()`. */
export async function setRidePassengers(rideId: string, expectedVersion: number, passengers: RidePassengerInput[]): Promise<void> {
  await rpc("set_ride_passengers", { p_ride_id: rideId, p_expected_version: expectedVersion, p_passengers: passengers as unknown as Json });
}

// ---------------------------------------------------------------------------
// Proposals (composer, list)
// ---------------------------------------------------------------------------

export async function fetchProposalsForWeek(departmentId: string, weekStart: string): Promise<ProposalRow[]> {
  const { data, error } = await supabase
    .from("proposals")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .order("created_at", { ascending: false });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchProposalParties(proposalId: string): Promise<ProposalPartyRow[]> {
  const { data, error } = await supabase.from("proposal_parties").select("*").eq("proposal_id", proposalId);
  if (error) throw toAppError(error);
  return data ?? [];
}

/** REQ §13.101 b: one WhatsApp text per party of a merge proposal (`{{link}}` left for the composer to fill). */
export async function fetchProposalPartyTexts(proposalId: string): Promise<Record<string, string>> {
  const rows = await rpc("proposal_party_texts", { p_proposal_id: proposalId });
  return Object.fromEntries((rows ?? []).flatMap((row) => (row.profile_id && row.body ? [[row.profile_id, row.body] as const] : [])));
}

export interface CreateProposalInput {
  requestId: string;
  rideId: string | null;
  type: ProposalType;
  payload: Json;
  reasonHe: string;
  partyProfileIds?: string[];
  createdVia?: string;
}

export async function createProposal(input: CreateProposalInput): Promise<string> {
  return rpc("create_proposal", {
    p_request_id: input.requestId,
    p_ride_id: input.rideId as unknown as string,
    p_type: input.type,
    p_payload: input.payload,
    p_reason_he: input.reasonHe,
    p_party_profile_ids: input.partyProfileIds ?? [],
    p_created_via: input.createdVia ?? "sadran",
  });
}

export interface SendProposalResult {
  proposal_token: string;
  party_tokens: Record<string, string>;
}

export async function sendProposal(
  proposalId: string,
  sentVia: NotificationChannel[] = [],
  replacement?: { id: string; version: number },
): Promise<SendProposalResult> {
  const result = await rpc("send_proposal", {
    p_proposal_id: proposalId, p_sent_via: sentVia,
    p_replace_proposal_id: replacement?.id,
    p_replace_expected_version: replacement?.version,
  });
  return result as unknown as SendProposalResult;
}

export async function recordAnswerOnBehalf(
  proposalId: string,
  profileId: string,
  accept: boolean,
  note?: string,
): Promise<void> {
  await rpc("record_answer_on_behalf", {
    p_proposal_id: proposalId,
    p_profile_id: profileId,
    p_accept: accept,
    p_note: note,
  });
}

/** REQ §13.94: Sadran discards an unsent draft (`draft` -> `withdrawn`). */
export async function discardProposal(proposalId: string): Promise<void> {
  await rpc("discard_proposal", { p_proposal_id: proposalId });
}

/** REQ §13.94: Sadran cancels a sent/accepted proposal (`-> withdrawn`, tokens revoked, no message to the member). */
export async function withdrawProposal(proposalId: string): Promise<void> {
  await rpc("withdraw_proposal", { p_proposal_id: proposalId });
}

export async function applyProposal(proposalId: string): Promise<string> {
  return rpc("apply_proposal", { p_proposal_id: proposalId });
}

/** The 5 seeded `wa.*` variants (UX_FLOWS.md §6.2) — `external`/`chauffeur` are documented but not seeded (stage 2b report). */
export async function fetchWhatsappTemplates(): Promise<NotificationTemplateRow[]> {
  const { data, error } = await supabase
    .from("notification_templates")
    .select("*")
    .eq("event", "proposal_received")
    .eq("channel", "whatsapp");
  if (error) throw toAppError(error);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Contested freed slots
// ---------------------------------------------------------------------------

export async function fetchFreedOffersForWeek(departmentId: string, weekStart: string): Promise<FreedSlotOfferRow[]> {
  const { data, error } = await supabase
    .from("freed_slot_offers")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .order("created_at", { ascending: false });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchClaimsForOffer(offerId: string): Promise<FreedSlotClaimRow[]> {
  const { data, error } = await supabase.from("freed_slot_claims").select("*").eq("offer_id", offerId);
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function approveClaim(offerId: string, requestId: string): Promise<string> {
  return rpc("approve_claim", { p_offer_id: offerId, p_request_id: requestId });
}

export async function closeOffer(offerId: string): Promise<void> {
  await rpc("close_offer", { p_offer_id: offerId });
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export async function fetchSiddurVersions(departmentId: string, weekStart: string): Promise<SiddurVersionRow[]> {
  const { data, error } = await supabase
    .from("siddur_versions")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .order("version_no", { ascending: false });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchLatestSiddurVersion(departmentId: string, weekStart: string): Promise<SiddurVersionRow | null> {
  const versions = await fetchSiddurVersions(departmentId, weekStart);
  return versions[0] ?? null;
}

export async function fetchPublishFingerprint(departmentId: string, weekStart: string): Promise<string> {
  return rpc("publish_scores_fingerprint", { p_department_id: departmentId, p_week_start: weekStart });
}

export interface PublicationDay {
  day: string;
  published: boolean;
  requestCount: number;
  /**
   * "Nobody placed this request" plus "an assigned request's legs are not
   * all covered" combined — kept for backward-compatible display; no longer
   * a blocker (REQ §13.75, DATA_MODEL.md §7.4a "`publication_readiness()`
   * gained a key"). `incompleteAssignments` below is the actual defect
   * (`ready`/publication blocks on it instead).
   */
  unresolvedRequests: number;
  /** The real defect split out of `unresolvedRequests`: an assigned/merged request whose legs are not all covered. `ready` keys off this, not `unresolvedRequests`. */
  incompleteAssignments: number;
  pendingProposals: number;
  /** REQ §13.94: unsent draft proposals of this day — `ready` requires 0 and `publish_siddur` raises `publication_drafts`. */
  draftProposals: number;
  missingDriverRides: number;
  conflictRides: number;
  ready: boolean;
}
export interface PublicationOptions { days?: string[]; allowUnanswered?: boolean }

export async function fetchPublicationReadiness(departmentId: string, weekStart: string): Promise<PublicationDay[]> {
  return await rpc("publication_readiness", { p_department_id: departmentId, p_week_start: weekStart }) as unknown as PublicationDay[];
}

export async function reopenWeek(departmentId: string, weekStart: string, phase: "open" | "solving", expectedFingerprint: string): Promise<void> {
  await rpc("reopen_week", { p_department_id: departmentId, p_week_start: weekStart, p_phase: phase, p_expected_fingerprint: expectedFingerprint });
}

/**
 * F2 (docs/TODO.md 2026-09-14): Sadran-only "change this week's request-closing time"
 * action, reached from the board's kebab menu (`SetWeekCloseAction`). `closeAt` is an ISO
 * instant already snapped to the 15-minute grid in Asia/Jerusalem; the RPC re-validates the
 * range and grid server-side and flips `open`/`solving` to match, same as
 * `advance_week_phases()` would once the deadline elapses.
 */
export async function setWeekCloseAt(departmentId: string, weekStart: string, closeAt: string): Promise<void> {
  await rpc("set_week_close_at", { p_department_id: departmentId, p_week_start: weekStart, p_close_at: closeAt });
}

export async function publishSiddur(departmentId: string, weekStart: string, scores: Json, fingerprint: string, policyScores: Json, options: PublicationOptions = {}): Promise<string> {
  return rpc("publish_siddur", { p_department_id: departmentId, p_week_start: weekStart,
    p_profile_scores: scores, p_expected_fingerprint: fingerprint, p_policy_scores: policyScores,
    p_days: options.days, p_allow_unanswered: options.allowUnanswered ?? false });
}

/** All non-cancelled rides of the week, for the publish diff and blocking-conflicts checks (same RLS as the board). */
export async function fetchAllWeekRides(departmentId: string, weekStart: string): Promise<BoardRide[]> {
  const { data, error } = await supabase
    .from("v_board_rides")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart);
  if (error) throw toAppError(error);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Profiles (recipient names/phones for the proposal composer)
// ---------------------------------------------------------------------------

export interface ProfileContact {
  id: string;
  full_name: string;
  phone: string | null;
}

export async function fetchProfilesByIds(profileIds: string[]): Promise<ProfileContact[]> {
  if (profileIds.length === 0) return [];
  const { data, error } = await supabase.from("profiles").select("id, full_name").in("id", profileIds);
  if (error) throw toAppError(error);
  const rows = data ?? [];
  const phones = await rpc("profile_phones", { p_ids: profileIds });
  const phoneById = new Map((phones ?? []).map((row) => [row.id, row.phone]));
  return rows.map((row) => ({ ...row, phone: phoneById.get(row.id) ?? null }));
}

export async function fetchAuditLog(departmentId: string, weekStart: string): Promise<AuditLogRow[]> {
  const { data, error } = await supabase
    .from("audit_log")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .order("at", { ascending: false })
    .limit(300);
  if (error) throw toAppError(error);
  return data ?? [];
}
