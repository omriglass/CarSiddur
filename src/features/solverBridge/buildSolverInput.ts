// src/features/solverBridge/buildSolverInput.ts
//
// Maps raw Supabase rows (requests, cars, seat configs, destinations,
// department_settings, ride_types, maintenance blocks, fairness_stats rows)
// into a pure `SolverInput` (docs/SOLVER.md §2). This is the *only* bridge
// between the DB shape and `src/solver`'s plain types — kept generic and
// reusable on purpose (CLAUDE.md: "the DB→solver mapping lives in the board
// feature ... never inside src/solver"; stage 2c places it here instead of
// `features/board/solverInput.ts` because the admin policy editor's "test on
// last week" preview needs the exact same mapping the Sadran board will need
// later — see docs/UX_FLOWS.md §12 stage 2c note).
//
// No React, no supabase-js calls here: callers (admin policy preview, later
// the board) fetch the rows and pass them in; this module is pure data
// shaping, safe to unit test with plain fixtures.

import { fromZonedTime } from "date-fns-tz";

import { isActiveStop } from "@/lib/routeStops";
import { TZ } from "@/lib/time";

import type {
  Assignment,
  Car as SolverCar,
  DayBounds,
  Destination as SolverDestination,
  Flexibility,
  FixedRide,
  Policy,
  Request as SolverRequest,
  SolverConfig,
  SolverInput,
  SolverStats,
  TravelEdge,
  Window,
} from "@/solver";

import type { Database } from "@/integrations/supabase/types";

export type RequestRow = Database["public"]["Tables"]["requests"]["Row"];
export type CarRow = Database["public"]["Tables"]["cars"]["Row"];
export type SeatConfigRow = Database["public"]["Tables"]["car_seat_configs"]["Row"];
export type DestinationRow = Database["public"]["Tables"]["destinations"]["Row"];
export type DepartmentSettingsRow = Database["public"]["Tables"]["department_settings"]["Row"];
export type MaintenanceBlockRow = Database["public"]["Tables"]["car_maintenance_blocks"]["Row"];
export type FairnessRow = Database["public"]["Functions"]["fairness_stats"]["Returns"][number];

/** Sentinel destination id for requests with free-text (unclassified) destinations. */
export const FREE_TEXT_DESTINATION_ID = "__free_text__";

const SLOT_MS = 15 * 60 * 1000;
const SLOTS_PER_DAY = 96;

/** `'0' | '15 min' | '30 min' | '1 hour' | '2 hours' | '1 day'` (requests_flex_*_ck) -> minutes, or `'day'`. */
export function parseFlexInterval(raw: string | null | undefined): number | "day" {
  if (!raw) return 0;
  const value = raw.trim().toLowerCase();
  if (value.includes("day")) return "day";
  const hms = /^(\d+):(\d+):(\d+)/.exec(value);
  if (hms) return Number(hms[1]) * 60 + Number(hms[2]);
  if (value === "0" || value === "00:00:00") return 0;
  return 0;
}

/** `"HH:MM"` or `"HH:MM:SS"` (Postgres `time`) -> minutes since midnight. */
export function parseTimeToMinutes(raw: string | null | undefined): number {
  if (!raw) return 0;
  const match = /^(\d+):(\d+)/.exec(raw.trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function epochMs(dateStr: string | null | undefined): number | undefined {
  if (!dateStr) return undefined;
  const parsed = Date.parse(dateStr);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function slotIndex(dateStr: string, weekStartMs: number): number {
  return Math.round((Date.parse(dateStr) - weekStartMs) / SLOT_MS);
}

/**
 * Full Sunday..Saturday week of 96-slot (midnight-to-midnight) days, matching
 * `src/solver/__fixtures__/gen.ts`'s `makeWeekDays()` convention rather than
 * `department_settings.board_start_time` — a documented simplification since
 * this mapper only powers an ad-hoc client-side preview, never the persisted
 * board (UX_FLOWS.md §12 stage 2c note).
 */
export function buildWeek(weekStart: string, dayEndTime: string): { startMs: number; days: DayBounds[] } {
  const startMs = fromZonedTime(`${weekStart}T00:00:00`, TZ).getTime();
  const dayEndMinutes = parseTimeToMinutes(dayEndTime);
  const dayEndSlotInDay = Math.min(SLOTS_PER_DAY - 1, Math.floor(dayEndMinutes / 15));
  const days: DayBounds[] = Array.from({ length: 7 }, (_, dayIndex) => {
    const start = dayIndex * SLOTS_PER_DAY;
    return {
      dayIndex: dayIndex as DayBounds["dayIndex"],
      startSlot: start,
      endSlot: start + SLOTS_PER_DAY,
      dayEndSlot: start + dayEndSlotInDay,
    };
  });
  return { startMs, days };
}

function flexOf(early: string | null, late: string | null): Flexibility {
  return { earlierMin: parseFlexInterval(early), laterMin: parseFlexInterval(late) };
}

export interface BuildSolverInputParams {
  weekStart: string;
  homeDestinationId: string;
  departmentSettings: Pick<
    DepartmentSettingsRow,
    "turnaround_minutes" | "detour_limit_minutes" | "detour_limit_km" | "chauffeur_dwell_minutes" | "day_end_time" | "stop_minutes"
  >;
  /**
   * Plain `requests` rows, optionally carrying `requester_does_not_drive` — REQ §88 (owner
   * 2026-09-15): `Request.canDrive = !requester_does_not_drive` — and `driving_companion_ids`,
   * the ids of this request's named companions (`request_companions`) who are eligible
   * drivers, i.e. `!profile.does_not_drive` (REQ §13.88, owner 2026-09-16, E1: "a driving
   * companion becomes the driver automatically" — mapped straight onto the solver's
   * `Request.drivingCompanionIds`). Both callers that feed the real solver/board preview embed
   * both (`sadran/api.ts`'s `fetchWeekRequests` and `fetchWeekRequestsWithNames`); callers that
   * don't (e.g. the admin policy preview's own plain `requests` fetch) simply leave every
   * request driving with no driving companions, same as before either field existed.
   */
  requests: (RequestRow & {
    requester_does_not_drive?: boolean;
    /** Requester's display name -> `Request.memberName` (reason texts only, SOLVER §3.13a); omit and merge hosts read as their car name. */
    requester_full_name?: string | null;
    driving_companion_ids?: string[];
    /**
     * `request_stops` rows (REQUIREMENTS §13.93 "Multi-stop rides", docs/ORIGINS_PLAN_2026-10.md
     * §6.1) -> `Request.stops`. Omit (or leave empty) for a request with no stops, exactly as
     * before this field existed.
     */
    stops?: { leg: "out" | "return"; position: number; active?: boolean; place_id: string | null }[];
  })[];
  /** `ride_type_id -> code` (policy `rideType` rule params are keyed by `ride_types.code`, SOLVER.md §4.3). */
  rideTypeCodesById: Record<string, string>;
  cars: CarRow[];
  seatConfigsByCarId: Record<string, SeatConfigRow[]>;
  destinations: DestinationRow[];
  maintenanceBlocksByCarId?: Record<string, MaintenanceBlockRow[]>;
  policy: Policy;
  /** `fairness_stats()` rows for the policy's `lookbackWeeks`; omit for an all-0.5 default. */
  fairness?: FairnessRow[];
  companionsByRequestId?: Record<string, string[]>;
  /**
   * `car_mileage_totals()` rows (F5, docs/SOLVER.md §3.6.2): rolling-window
   * km per car, keyed by `car_id`. Omit entirely (or pass `{}`) to leave
   * every car's `mileageKm` undefined — car choice is then identical to
   * before this feature existed (docs/SOLVER.md §3.6.2 "opt-in").
   */
  mileageKmByCarId?: Record<string, number>;
  now?: () => number;
  /**
   * Already-placed rides to seed as constraints (pinned rides, accepted
   * proposals, temporary-car-owner rides — SOLVER.md §5.1 "solve remaining
   * only"/re-solve semantics). Defaults to `[]`, this function's original
   * behavior (stage 2c's policy preview never needed fixed rides); the
   * Sadran board (stage 2b) is the first caller that does. Callers are
   * responsible for excluding the requests these rides already serve from
   * `requests` — the solver itself does not cross-reference the two arrays
   * (SOLVER.md §5.1: "the caller decides which requests are open").
   */
  fixedRides?: FixedRide[];
  /**
   * `car_start_locations(p_department_id, p_week_start)` rows, keyed by
   * `car_id` (REQUIREMENTS §13.93, docs/ORIGINS_PLAN_2026-10.md §2 item 7):
   * `locationId` -> `Car.startLocationId`, `baseLocationId` -> (unused here;
   * `cars.base_location_id` on the car row itself is the source of truth for
   * `Car.baseLocationId` — see `car.base_location_id` below). Omit (or leave
   * a car out of the map) to default to the department home, as before this
   * field existed.
   */
  carStartLocationsByCarId?: Record<string, { locationId: string; baseLocationId: string }>;
  /**
   * `place_travel_for_week(p_department_id, p_week_start)` rows (REQUIREMENTS
   * §13.93, ORIGINS_PLAN §2 item 6) -> `SolverInput.travel`, read only via
   * `travelBetween()`. Omit for `[]` (every non-home-origin leg then falls
   * back to `config.defaultTravelMinutes`, as before this field existed).
   */
  travel?: TravelEdge[];
  /**
   * Continuity hints for a full re-solve (SOLVER.md §5.1: "a full re-run ...
   * supplies the previous draft as `previousAssignments` so continuity ...
   * minimizes churn", `greedy.ts`'s `continuityRank`). Bug-fix pass
   * (docs/UX_FLOWS.md §19 "Solve/apply semantics after owner testing"):
   * every non-pinned ride that existed before a full re-solve — the ones a
   * full re-solve is allowed to replace — is passed here so the solver
   * prefers to keep each request's members on the same car rather than
   * reshuffling everyone. Omit for `'remaining'` mode (nothing is replaced
   * there, so there is nothing to keep continuity with).
   */
  previousAssignments?: Pick<Assignment, "servedRequestIds" | "carId">[];
}

function toSolverDestination(row: DestinationRow): SolverDestination {
  return {
    id: row.id,
    name: row.name || undefined,
    zone: row.zone,
    distanceKm: row.distance_km ?? undefined,
    travelMinutes: row.travel_minutes ?? undefined,
    publicTransportScore:
      row.public_transport_score !== null && row.public_transport_score !== undefined
        ? row.public_transport_score / 5
        : undefined,
  };
}

function toWindow(startsAt: string, endsAt: string, weekStartMs: number): Window {
  return { start: slotIndex(startsAt, weekStartMs), end: slotIndex(endsAt, weekStartMs) };
}

/**
 * `fairness_stats()` -> 0..1 priority boost from granted ride-hours only.
 * The most-served member in the lookback gets 0; no granted history is a
 * neutral 0.5 for everyone. Request volume never enters this calculation.
 */
export function fairnessDeficits(rows: FairnessRow[]): Record<string, { deficit: number }> {
  const maxGrantedHours = Math.max(0, ...rows.map((row) => Number(row.granted_hours) || 0));
  if (maxGrantedHours === 0) return Object.fromEntries(rows.map((row) => [row.profile_id, { deficit: 0.5 }]));
  return Object.fromEntries(rows.map((row) => [row.profile_id, {
    deficit: Math.min(1, Math.max(0, 1 - (Number(row.granted_hours) || 0) / maxGrantedHours)),
  }]));
}

/** Builds a pure `SolverInput` for one department/week from raw Supabase rows. */
export function buildSolverInput(params: BuildSolverInputParams): SolverInput {
  const { week, startMs: weekStartMs } = (() => {
    const built = buildWeek(params.weekStart, params.departmentSettings.day_end_time);
    return { week: built, startMs: built.startMs };
  })();

  const destinationsById: Record<string, SolverDestination> = {};
  for (const row of params.destinations) destinationsById[row.id] = toSolverDestination(row);
  const needsFreeTextEntry = params.requests.some((r) => !r.destination_id);
  if (needsFreeTextEntry && !destinationsById[FREE_TEXT_DESTINATION_ID]) {
    destinationsById[FREE_TEXT_DESTINATION_ID] = { id: FREE_TEXT_DESTINATION_ID, zone: "unknown" };
  }

  const requests: SolverRequest[] = params.requests
    .filter((r) => r.status !== "draft")
    .map((r) => {
      const oneWayCarMode =
        r.one_way_car_mode === "relay" || r.one_way_car_mode === "passenger" ? r.one_way_car_mode : undefined;
      return {
        id: r.id,
        memberId: r.requester_id,
        memberName: r.requester_full_name || undefined,
        destinationText: r.destination_text || undefined,
        originText: r.origin_text || undefined,
        departmentId: r.department_id,
        destinationId: r.destination_id ?? FREE_TEXT_DESTINATION_ID,
        rideType: params.rideTypeCodesById[r.ride_type_id] ?? "other",
        tripShape: r.trip_shape,
        // REQUIREMENTS §13.93 (ORIGINS_PLAN §4 item 1): `origin_id` is null for a
        // free-text origin (then `origin_text` is set) or for a legacy/pre-backfill
        // row (home default) — only the free-text case sets `originIsFreeText`.
        originId: r.origin_id ?? undefined,
        originIsFreeText: !r.origin_id && !!r.origin_text,
        destinationIsFreeText: !r.destination_id,
        // Always passed explicitly (never left to the solver's own legacy-field
        // derivation): a stored `trip_type = 'one_way'` has legacy `trip_shape =
        // 'one_way_to'`, which `effectiveTripType()` would otherwise derive to
        // `drop_off` if `tripType` were omitted (ORIGINS_PLAN §4 item 1).
        // A free-text destination is not a place a car can stay at (REQ §13.58: it can never
        // relay), so a `one_way` to one is placed as a chauffeur ride (`drop_off`).
        tripType: r.trip_type === "one_way" && !r.destination_id ? "drop_off" : r.trip_type,
        oneWayCarMode,
        // REQ §88 (owner 2026-09-15): everyone can drive unless they said otherwise in their
        // profile; `undefined` here (field not selected by this particular caller) also means
        // "can drive" — see `canDrive?: boolean`'s own doc comment in `src/solver/types.ts`.
        canDrive: r.requester_does_not_drive ? false : undefined,
        drivingCompanionIds: r.driving_companion_ids?.length ? r.driving_companion_ids : undefined,
        departureMs: epochMs(r.depart_at),
        returnMs: epochMs(r.return_at),
        flexDeparture: flexOf(r.flex_depart_early, r.flex_depart_late),
        flexReturn: flexOf(r.flex_return_early, r.flex_return_late),
        passengers: { adults: r.adults, childSeats: r.child_seats, boosters: r.boosters },
        coRiderMemberIds: params.companionsByRequestId?.[r.id] ?? [],
        luggage: r.has_luggage,
        needsCarAtDestination: r.needs_car_at_destination,
        preferredCarId: params.cars.some((car) => car.id === r.preferred_car_id && car.department_id === r.department_id && car.type === "shared" && car.status === "active")
          ? r.preferred_car_id ?? undefined : undefined,
        submittedAtMs: epochMs(r.submitted_at ?? r.created_at) ?? weekStartMs,
        isLate: r.is_late,
        manualBoost:
          r.manual_boost && r.manual_boost !== 0
            ? { value: r.manual_boost, reason: r.manual_boost_reason ?? "" }
            : undefined,
        // Multi-day series (SOLVER.md §3.x): one request row per calendar day
        // sharing series_id; the solver only sees the legs inside this week.
        // Legs in another week are handled by SQL's place_series() after
        // apply_solver_result — see DATA_MODEL.md for the column definitions.
        seriesId: r.series_id ?? undefined,
        seriesIndex: r.series_index ?? undefined,
        seriesCount: r.series_count ?? undefined,
        // REQUIREMENTS §13.93 "Multi-stop rides": array order = route order per leg
        // (`src/solver/travel.ts`'s `legRoute()` filters by leg, so only the within-leg
        // relative order matters) — sorted by `position` since the embed itself carries no
        // ordering guarantee.
        // REQ §13.97: only active stops (a one-way request keeps its return stops dormant).
        stops: r.stops?.some((s) => isActiveStop(s, r.return_at != null))
          ? r.stops
              .filter((s) => isActiveStop(s, r.return_at != null))
              .sort((a, b) => a.leg.localeCompare(b.leg) || a.position - b.position)
              .map((s) => ({ leg: s.leg, locationId: s.place_id ?? undefined }))
          : undefined,
      } satisfies SolverRequest;
    });

  // `startLocationId` (SOLVER.md §3.x, Car.startLocationId) now comes from the
  // `car_start_locations()` RPC when the caller fetches and passes it in
  // (REQUIREMENTS §13.93, ORIGINS_PLAN §2 item 7); omitted (or a car left out
  // of the map), it defaults to home (src/solver/timeline.ts) exactly as
  // before this field existed. The hard guarantee that a continuing series'
  // car is actually where the previous week's SQL `place_series()` left it is
  // still `assert_car_chain()` in SQL, not this mapper (CLAUDE.md decision 14,
  // SOLVER.md §1.3.8).
  const cars: SolverCar[] = params.cars.map((car) => ({
    id: car.id,
    name: car.name,
    type: car.type,
    ownerMemberId: car.owner_id ?? undefined,
    seatConfigs: (params.seatConfigsByCarId[car.id] ?? []).map((sc) => ({
      adults: sc.adults,
      childSeats: sc.child_seats,
      boosters: sc.boosters,
    })),
    features: car.features,
    luggageCapacity: car.features.includes("large_trunk") ? 2 : 0,
    maintenance: (params.maintenanceBlocksByCarId?.[car.id] ?? []).map((b) =>
      toWindow(b.starts_at, b.ends_at, weekStartMs),
    ),
    mileageKm: params.mileageKmByCarId?.[car.id],
    startLocationId: params.carStartLocationsByCarId?.[car.id]?.locationId,
    // REQUIREMENTS §13.93: `cars.base_location_id` (null = home, CarRow already
    // carries it since every caller selects the full row).
    // Prefer `car_start_locations().base_location_id` (= SQL `car_base_location()`: the car's
    // base, else — for a temporary car — its owner's default origin, else home), so the
    // TEMP_CAR_AWAY invariant agrees with SQL.
    baseLocationId:
      params.carStartLocationsByCarId?.[car.id]?.baseLocationId ?? car.base_location_id ?? undefined,
  }));

  const fairness: SolverStats["fairness"] = fairnessDeficits(params.fairness ?? []);

  const config: SolverConfig = {
    bufferMinutes: params.departmentSettings.turnaround_minutes,
    detour: {
      maxMinutes: params.departmentSettings.detour_limit_minutes,
      maxKm: params.departmentSettings.detour_limit_km,
    },
    beyondFlexMaxMinutes: 120,
    defaultTravelMinutes: 60,
    chauffeurDwellMinutes: params.departmentSettings.chauffeur_dwell_minutes,
    // REQUIREMENTS §13.93 "Multi-stop rides" (ORIGINS_PLAN §6.2): `department_settings.
    // stop_minutes` -> dwell time per stop, read by `legRouteMinutes()`/`stopEtas()`.
    stopMinutes: params.departmentSettings.stop_minutes,
    improvementBudget: 5000,
    perRequestBudget: 200,
    externalHints: { cabMaxMinutes: 90, rentalMinHours: 30, ptMinScore: 0.6 },
  };

  return {
    week,
    homeLocationId: params.homeDestinationId,
    cars,
    requests,
    fixedRides: params.fixedRides ?? [],
    destinations: destinationsById,
    policy: params.policy satisfies Policy,
    stats: { fairness, usualCarId: {} },
    config,
    travel: params.travel,
    now: params.now,
    previousAssignments: params.previousAssignments,
  };
}
