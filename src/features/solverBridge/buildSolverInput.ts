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
    "turnaround_minutes" | "detour_limit_minutes" | "detour_limit_km" | "chauffeur_dwell_minutes" | "day_end_time"
  >;
  requests: RequestRow[];
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

/** `fairness_stats()` row -> 0..1 deficit (`unmet / requested`, per DATA_MODEL.md §7.3; default 0.5 with no history). */
function fairnessDeficit(row: FairnessRow): number {
  if (!row.requested) return 0.5;
  return Math.min(1, Math.max(0, row.unmet / row.requested));
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
        departmentId: r.department_id,
        destinationId: r.destination_id ?? FREE_TEXT_DESTINATION_ID,
        rideType: params.rideTypeCodesById[r.ride_type_id] ?? "other",
        tripShape: r.trip_shape,
        oneWayCarMode,
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
      } satisfies SolverRequest;
    });

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
    luggageCapacity: car.features.includes("large_trunk") ? 2 : 1,
    maintenance: (params.maintenanceBlocksByCarId?.[car.id] ?? []).map((b) =>
      toWindow(b.starts_at, b.ends_at, weekStartMs),
    ),
  }));

  const fairness: SolverStats["fairness"] = {};
  for (const row of params.fairness ?? []) fairness[row.profile_id] = { deficit: fairnessDeficit(row) };

  const config: SolverConfig = {
    bufferMinutes: params.departmentSettings.turnaround_minutes,
    detour: {
      maxMinutes: params.departmentSettings.detour_limit_minutes,
      maxKm: params.departmentSettings.detour_limit_km,
    },
    beyondFlexMaxMinutes: 120,
    defaultTravelMinutes: 60,
    chauffeurDwellMinutes: params.departmentSettings.chauffeur_dwell_minutes,
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
    now: params.now,
    previousAssignments: params.previousAssignments,
  };
}
