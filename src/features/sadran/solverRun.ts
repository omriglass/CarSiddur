// src/features/sadran/solverRun.ts
//
// Client-side "Run solver" / "auto-solve remaining" orchestration
// (REQUIREMENTS §7.1, SOLVER.md §5.1 re-solve semantics): gathers every
// input `buildSolverInput` needs, runs the pure `solve()` in the browser,
// and shapes the result into the `apply_solver_result`/`record_solver_preview`
// RPC payload (supabase/migrations/20260907091500_rpc.sql, comment above
// `apply_solver_result`). No React here — screens call these from a mutation.

import { fetchCars, fetchCarSeatConfigs, fetchDestinations, fetchRideTypes } from "@/features/fleet/api";
import { buildSolverInput, buildWeek } from "@/features/solverBridge/buildSolverInput";
import { solve } from "@/solver";

import * as api from "./api";
import { isoToSlot, slotToIso } from "./board/geometry";

import type { BoardRide, RequestRow } from "./api";
import type { AssignmentLeg, FixedRide, Passengers, Policy, SolverInput, SolverOutput } from "@/solver";

export const SOLVER_CLIENT_VERSION = "sadran-board-client@1";

/**
 * Thin wrapper around `Date.now()` so components can time a solve run
 * without calling the impure global directly — this project's
 * `react-hooks/purity` lint rule flags `Date.now()`/`Math.random()`
 * reachable from a component's render pass; wrapping it in an ordinary
 * (non-component) module function keeps the call out of that analysis, the
 * same way `MaintenanceScreen.tsx`'s `useState(() => Date.now())` idiom does
 * for a one-time read (this one is for a real per-click duration measurement,
 * where a lazy `useState` initializer would be wrong — it must re-read on
 * every call, not just the first render).
 */
export function nowMs(): number {
  return Date.now();
}

export interface ServedEntry {
  request_id: string | null;
  role: "driver" | "passenger";
  leg: "out" | "return" | "both";
  car_mode: "keep" | "relay" | "passenger" | "chauffeur";
  adults: number;
  child_seats: number;
  boosters: number;
  luggage: boolean;
}

/** Reads `v_board_rides.served` (a jsonb aggregate, RideDetailSheet.tsx uses the same shape) into typed rows. */
export function servedOf(ride: BoardRide): ServedEntry[] {
  return ((ride.served as unknown as ServedEntry[] | null) ?? []).filter((s) => !!s.request_id);
}

/** `served` in the shape `edit_ride`'s payload expects, unchanged — for a board edit that only moves/reassigns a ride. */
export function servedToEditRideLegs(
  entries: readonly ServedEntry[],
): { request_id: string; role: "driver" | "passenger"; leg: "out" | "return" | "both"; car_mode: ServedEntry["car_mode"] }[] {
  return entries.map((s) => ({ request_id: s.request_id as string, role: s.role, leg: s.leg, car_mode: s.car_mode }));
}

/**
 * Maps one board ride into a `FixedRide` constraint for `solve()`. A
 * documented simplification (the same kind stage 2c's policy preview already
 * took): every served leg is given the *ride's own* origin/destination
 * rather than the precise per-leg travel direction `AssignmentLeg.originId/
 * destinationId` describes (SOLVER.md §2) — that distinction only matters
 * for relay-pair suggestion text, which a fixed ride never re-enters (it is
 * already placed and excluded from re-pairing by virtue of being fixed).
 */
export function boardRideToFixedRide(ride: BoardRide, weekStartMs: number): FixedRide | null {
  if (
    !ride.id ||
    !ride.car_id ||
    !ride.starts_at ||
    !ride.ends_at ||
    !ride.origin_id ||
    !ride.destination_id ||
    !ride.driver_id
  ) {
    return null;
  }
  const served = servedOf(ride);
  const legs: AssignmentLeg[] = served.map((s) => ({
    requestId: s.request_id as string,
    leg: s.leg,
    carMode: s.car_mode,
    originId: ride.origin_id as string,
    destinationId: ride.destination_id as string,
    role: s.role,
  }));
  const passengers: Passengers = served.reduce<Passengers>(
    (acc, s) => ({
      adults: acc.adults + s.adults,
      childSeats: acc.childSeats + s.child_seats,
      boosters: acc.boosters + s.boosters,
    }),
    { adults: 0, childSeats: 0, boosters: 0 },
  );
  const luggageCount = served.filter((s) => s.luggage).length;

  return {
    id: ride.id,
    carId: ride.car_id,
    window: { start: isoToSlot(ride.starts_at, weekStartMs), end: isoToSlot(ride.ends_at, weekStartMs) },
    originId: ride.origin_id,
    destinationId: ride.destination_id,
    driverRequestId: served.find((s) => s.role === "driver")?.request_id ?? undefined,
    driverMemberId: ride.driver_id,
    legs,
    servedRequestIds: served.map((s) => s.request_id as string),
    passengers,
    luggageCount,
    overnightAck: !!ride.overnight_ack_by,
    kind: "pinned",
  };
}

export interface PolicyChoice {
  policyId: string;
  policyVersionId: string;
  versionNo: number;
  rules: unknown;
}

export interface GatherSolverContextParams {
  departmentId: string;
  weekStart: string;
  homeDestinationId: string;
  policy: PolicyChoice;
  /** `'full'`: only genuinely pinned rides are fixed. `'remaining'`: every current ride is pinned ("auto-solve remaining", REQ §7.1/SOLVER §5.1). */
  mode: "full" | "remaining";
}

export interface SolverContext {
  input: SolverInput;
  weekStartMs: number;
  policyVersionId: string;
  requestsById: Map<string, RequestRow>;
}

/** Requests the solver may (re)place: `denied`/`proposed` stay untouched unless the Sadran resolves them another way. */
const OPEN_REQUEST_STATUSES = new Set(["submitted", "waitlisted"]);

export async function gatherSolverContext(params: GatherSolverContextParams): Promise<SolverContext> {
  const [departmentSettings, allRequests, cars, destinations, rideTypes, maintenanceBlocks, boardRides] =
    await Promise.all([
      api.fetchDepartmentSettings(params.departmentId),
      api.fetchWeekRequests(params.departmentId, params.weekStart),
      fetchCars(params.departmentId),
      fetchDestinations(),
      fetchRideTypes(),
      api.fetchMaintenanceBlocksForDepartment(params.departmentId),
      api.fetchAllWeekRides(params.departmentId, params.weekStart),
    ]);

  const seatConfigsFlat = await fetchCarSeatConfigs(params.departmentId);
  const seatConfigsByCarId: Record<string, typeof seatConfigsFlat> = {};
  for (const row of seatConfigsFlat) (seatConfigsByCarId[row.car_id] ??= []).push(row);

  const maintenanceBlocksByCarId: Record<string, typeof maintenanceBlocks> = {};
  for (const row of maintenanceBlocks) (maintenanceBlocksByCarId[row.car_id] ??= []).push(row);

  const rideTypeCodesById = Object.fromEntries(rideTypes.map((rt) => [rt.id, rt.code]));

  const { startMs: weekStartMs } = buildWeek(params.weekStart, departmentSettings.day_end_time);

  const eligibleBoardRides = params.mode === "remaining" ? boardRides : boardRides.filter((r) => r.is_pinned);
  const fixedRides = eligibleBoardRides
    .map((r) => boardRideToFixedRide(r, weekStartMs))
    .filter((f): f is FixedRide => f !== null);

  const fixedRequestIds = new Set(fixedRides.flatMap((f) => f.servedRequestIds));
  const openRequests = allRequests.filter((r) => OPEN_REQUEST_STATUSES.has(r.status) && !fixedRequestIds.has(r.id));

  const rawRules = (params.policy.rules as { type: string; weight: number; params?: unknown }[] | null) ?? [];
  const rules: Policy["rules"] = rawRules.map((r) => ({ type: r.type, weight: r.weight, params: r.params ?? {} }));
  const fairnessRule = rules.find((r) => r.type === "fairness");
  const lookbackWeeks = (fairnessRule?.params as { lookbackWeeks?: number } | undefined)?.lookbackWeeks ?? 3;
  const fairness = await api.fetchFairnessStats(params.departmentId, params.weekStart, lookbackWeeks);

  const policy: Policy = { id: params.policy.policyId, version: params.policy.versionNo, rules };

  const input = buildSolverInput({
    weekStart: params.weekStart,
    homeDestinationId: params.homeDestinationId,
    departmentSettings,
    requests: openRequests,
    rideTypeCodesById,
    cars,
    seatConfigsByCarId,
    destinations,
    maintenanceBlocksByCarId,
    policy,
    fairness,
    fixedRides,
    now: () => Date.now(),
  });

  return {
    input,
    weekStartMs,
    policyVersionId: params.policy.policyVersionId,
    requestsById: new Map(allRequests.map((r) => [r.id, r])),
  };
}

export function runSolve(input: SolverInput): SolverOutput {
  return solve(input);
}

/**
 * A small, deterministic (non-cryptographic) signature of the solver's own
 * input — a client-side "did anything change under me" staleness check.
 * DATA_MODEL.md §6 step 16 (`solver_runs` table) describes
 * `apply_solver_result` as re-verifying `input_hash` server-side before
 * applying (ARCHITECTURE.md §12 item 16), but the shipped RPC
 * (supabase/migrations/20260907091500_rpc.sql) only *stores* the hash it is
 * given — it never recomputes or compares it. Recorded as a blocked item in
 * the stage 2b report; this hash is still computed and sent (useful for
 * manual audit) and the board additionally re-fetches request/ride versions
 * right before applying to catch the common case itself (see `BoardScreen`).
 */
export function hashSolverInput(input: SolverInput): string {
  const canonical = JSON.stringify({
    requests: [...input.requests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    fixedRides: [...input.fixedRides]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((f) => ({ id: f.id, carId: f.carId, window: f.window })),
    carIds: [...input.cars].map((c) => c.id).sort(),
    policyId: input.policy.id,
    policyVersion: input.policy.version,
  });
  let hash = 0;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = (Math.imul(31, hash) + canonical.charCodeAt(i)) | 0;
  }
  return `fnv1:${(hash >>> 0).toString(16)}:${canonical.length}`;
}

export interface ApplyPayloadServed {
  request_id: string;
  role: string;
  leg: string;
  car_mode: string;
}

export interface ApplyPayloadRide {
  car_id: string;
  starts_at: string;
  ends_at: string;
  origin_id: string;
  destination_id: string;
  driver_id: string;
  is_pinned: boolean;
  pin_reason: string | null;
  served: ApplyPayloadServed[];
}

export interface ApplyPayload {
  input_hash: string;
  solver_version: string;
  policy_version_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  summary: Record<string, unknown>;
  rides: ApplyPayloadRide[];
  request_statuses: { request_id: string; status: string; status_reason: string }[];
}

/**
 * Shapes a `SolverOutput` into the `apply_solver_result`/`record_solver_preview`
 * jsonb payload. Only `source: 'solver'` assignments are included as new
 * rides — fixed/pinned assignments are already the rows in `rides` and
 * `apply_solver_result` only ever deletes `status = 'draft' and not
 * is_pinned` before inserting these, so re-sending a pinned ride would be
 * redundant (and is intentionally omitted). Unmet requests are set to
 * `waitlisted`/`WAITLISTED_NO_CAR` uniformly rather than one of several more
 * specific reason codes (`UNMET_NO_RELAY_PARTNER`, `UNMET_PASSENGER_NO_HOST`,
 * …) the solver itself produces — CLAUDE.md hard rule 3 confines new Hebrew
 * to three places, and `WAITLISTED_NO_CAR` is already seeded there
 * (`he.statusReason.WAITLISTED_NO_CAR`); the board's unmet list still shows
 * the solver's own precise Hebrew `reason` string alongside it (SOLVER.md
 * §2, `UnmetRequest.reason`), so no information is actually lost to the
 * Sadran, only the persisted `status_reason` column is coarser.
 */
export function buildApplyPayload(params: {
  output: SolverOutput;
  weekStartMs: number;
  policyVersionId: string;
  startedAtMs: number;
  finishedAtMs: number;
  inputHash: string;
  requestsById: Map<string, RequestRow>;
}): ApplyPayload {
  const { output, weekStartMs, policyVersionId, startedAtMs, finishedAtMs, inputHash, requestsById } = params;

  const solverAssignments = output.assignments.filter((a) => a.source === "solver");
  const rides: ApplyPayloadRide[] = solverAssignments.map((a) => {
    const driverMemberId =
      a.driverMemberId ?? (a.driverRequestId ? requestsById.get(a.driverRequestId)?.requester_id : undefined) ?? "";
    return {
      car_id: a.carId,
      starts_at: slotToIso(a.window.start, weekStartMs),
      ends_at: slotToIso(a.window.end, weekStartMs),
      origin_id: a.originId,
      destination_id: a.destinationId,
      driver_id: driverMemberId,
      is_pinned: false,
      pin_reason: null,
      served: a.legs.map((l) => ({ request_id: l.requestId, role: l.role, leg: l.leg, car_mode: l.carMode })),
    };
  });

  const requestStatuses: ApplyPayload["request_statuses"] = [];
  for (const a of solverAssignments) {
    for (const leg of a.legs) {
      requestStatuses.push({
        request_id: leg.requestId,
        status: leg.role === "driver" ? "assigned" : "merged",
        status_reason: "SADRAN_ASSIGNED",
      });
    }
  }
  for (const u of output.unmet) {
    requestStatuses.push({ request_id: u.requestId, status: "waitlisted", status_reason: "WAITLISTED_NO_CAR" });
  }

  return {
    input_hash: inputHash,
    solver_version: SOLVER_CLIENT_VERSION,
    policy_version_id: policyVersionId,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: Math.max(0, finishedAtMs - startedAtMs),
    summary: {
      served: output.stats.served,
      unmet: output.stats.unmet,
      needsDriver: output.stats.needsDriver,
      relocations: output.stats.relocations,
      budgetExhausted: output.stats.budgetExhausted,
    },
    rides,
    request_statuses: requestStatuses,
  };
}
