// src/features/sadran/applySolve.ts
//
// Solve/apply orchestration for the Sadran board and week dashboard
// (REQUIREMENTS §7.1, SOLVER.md §5, docs/UX_FLOWS.md §19 "Solve/apply
// semantics after owner testing"). Gathers every input `buildSolverInput`
// needs, runs the pure `solve()` in the browser, and shapes the result into
// the `apply_solver_result`/`record_solver_preview` RPC payload
// (supabase/migrations/20260907091500_rpc.sql + 20260907093300_*.sql).
// No React here — screens call these from a mutation. `solverRun.ts`
// re-exports everything from this module (kept as a thin compatibility
// shim so existing imports do not need to change).
//
// --- Bug: rides disappearing even after the mode='full'/'remaining' fix ---
//
// Owner report (after the previous fix pass, docs/UX_FLOWS.md §17 item 5):
// "clicking Solve and Autofill STILL sometimes makes certain rides
// disappear." Reproduced directly: Solve → Apply, then Solve → Apply again
// with *no changes in between* (sequence (a) of the investigation) makes
// every ride the first solve placed vanish from the board on the second
// apply, while the requests they served stay stuck at `assigned`/`merged`
// with no ride at all — exactly what an owner would call "rides
// disappearing" (its ride is gone; the request never returns to the unmet
// list because nothing ever marks it `waitlisted` either).
//
// Root cause (was in the old `gatherSolverContext`, this file's
// predecessor `solverRun.ts`): `OPEN_REQUEST_STATUSES = new
// Set(['submitted', 'waitlisted'])` decided which requests the solver was
// even shown, *by request status*, while `eligibleBoardRides` (which rides
// become `fixedRides`) decided independently *by `is_pinned`*. In `'full'`
// mode `eligibleBoardRides` is only genuinely pinned rides — but a request
// already `assigned`/`merged` by a *previous solve's own unpinned ride* has
// neither status `submitted`/`waitlisted` (so `OPEN_REQUEST_STATUSES`
// excludes it) nor a pinned ride (so it is not a `fixedRide` either). It
// falls into neither bucket: the solver never sees it, so `solve()`'s
// output never mentions it (not in `assignments`, not in `unmet`) — yet
// `apply_solver_result`'s `'full'` mode still deletes every unpinned draft
// ride, including this one, because from the RPC's point of view an
// unpinned ride is by definition solver-made and replaceable. The request
// row is never touched (it is not in the payload's `request_statuses`
// either), so it is left `assigned`/`merged` pointing at nothing.
//
// Fix: a request is "open" (fed to `solve()`) whenever it is *not already
// served by a `fixedRide`* and its status is not one the solver must never
// silently touch (`draft`/`proposed`/`denied`/`external`/`withdrawn`/
// `cancelled` — mid-negotiation or already resolved by the Sadran another
// way). `assigned`/`merged` requests are reopened exactly when their ride
// is not fixed — i.e. exactly the requests a `'full'` re-solve is actually
// allowed to touch. This makes every request `solve()` is allowed to move
// show up somewhere in its output (an assignment, or `unmet` → the RPC then
// marks it `waitlisted`), so nothing is ever silently orphaned in either
// mode. Covered by `applySolve.test.ts` and
// `supabase/tests/solve_semantics.sql`.

import { fetchCars, fetchCarSeatConfigs, fetchDestinations, fetchRideTypes } from "@/features/fleet/api";
import { buildSolverInput, buildWeek } from "@/features/solverBridge/buildSolverInput";
import { solve } from "@/solver";

import * as api from "./api";
import { isoToSlot, slotToIso } from "./board/geometry";

import type { BoardRide, RequestRow } from "./api";
import type { Assignment, AssignmentLeg, FixedRide, Passengers, Policy, SolverInput, SolverOutput } from "@/solver";

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
    !ride.destination_id
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
    driverMemberId: ride.driver_id ?? undefined,
    legs,
    servedRequestIds: served.map((s) => s.request_id as string),
    passengers,
    luggageCount,
    overnightAck: !!ride.overnight_ack_by,
    approvedBufferAfterSlots: ride.turnaround_override_minutes == null ? undefined : Math.ceil(ride.turnaround_override_minutes / 15),
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
  /**
   * `'remaining'` ("שבץ בקשות פתוחות" / "solve open requests" — the
   * PRIMARY action, REQUIREMENTS §7.1, SOLVER.md §5.1): every current ride
   * is pinned as a `fixedRide`, so `apply_solver_result` only ever *adds*
   * rides for requests that were genuinely still open — nothing already
   * placed can ever move or disappear.
   *
   * `'full'` ("פתור מחדש את כל השבוע" / "re-solve the whole week" — a
   * separate, explicit action): only genuinely pinned rides (manual edits,
   * accepted proposals, temporary-car owner rides, live auto-approvals —
   * every one of them sets `rides.is_pinned = true`) are fixed; every other
   * currently-served request is reopened and may be replaced. Always pairs
   * with `previousAssignments` for continuity and, on the caller side, a
   * confirm step naming what would change (see `computeFullResolveDiff`).
   */
  mode: "full" | "remaining";
  /** Publication scoring includes every submitted outcome, including fixed and denied requests. */
  forScoring?: boolean;
}

export interface SolverContext {
  input: SolverInput;
  weekStartMs: number;
  policyVersionId: string;
  requestsById: Map<string, RequestRow>;
  /** `'full'` only: the non-pinned board rides this re-solve may replace (for `computeFullResolveDiff`). */
  replaceableRides: BoardRide[];
  boardRides: BoardRide[];
}

/**
 * Requests a re-solve is allowed to reconsider once they are not already
 * served by a `fixedRide`: `submitted`/`waitlisted` (genuinely never
 * placed) as well as `assigned`/`merged` (placed by a *non-fixed*, i.e.
 * solver-made, ride — exactly the rides a re-solve may replace). Excludes
 * `draft` (not yet submitted), `proposed` (a proposal is mid-flight, the
 * Sadran must resolve it explicitly), and the resolved-elsewhere terminal
 * statuses `denied`/`external`/`withdrawn`/`cancelled` — the solver is
 * stateless about status (SOLVER.md §5.1); this is the caller's policy.
 *
 * This replaces the old, narrower `OPEN_REQUEST_STATUSES = {submitted,
 * waitlisted}` allow-list, which was the root cause of the "rides
 * disappear" bug described in this file's header comment: an
 * `assigned`/`merged` request whose ride was *not* fixed used to be
 * invisible to the solver entirely (neither open nor a `fixedRide`), so a
 * `'full'` re-solve deleted its ride without ever being asked to replace
 * it.
 */
const REOPENABLE_REQUEST_STATUSES = new Set(["submitted", "waitlisted", "assigned", "merged"]);

/**
 * Pure filter, extracted from `gatherSolverContext` so the actual bug fix
 * (see this file's header comment) is unit-testable without mocking every
 * Supabase fetch `gatherSolverContext` makes — `applySolve.test.ts` exercises
 * this directly with the exact "assigned request, unpinned ride, full mode"
 * shape that used to make the request invisible to the solver.
 */
export function selectOpenRequests<R extends { id: string; status: string }>(
  allRequests: readonly R[],
  fixedRequestIds: ReadonlySet<string>,
): R[] {
  return allRequests.filter((r) => REOPENABLE_REQUEST_STATUSES.has(r.status) && !fixedRequestIds.has(r.id));
}

export async function gatherSolverContext(params: GatherSolverContextParams): Promise<SolverContext> {
  const [departmentSettings, allRequests, cars, destinations, rideTypes, maintenanceBlocks, boardRides] =
    await Promise.all([
      api.fetchDepartmentSettings(params.departmentId),
      api.fetchWeekRequests(params.departmentId, params.weekStart),
      fetchCars(params.departmentId),
      fetchDestinations(params.departmentId),
      fetchRideTypes(params.departmentId),
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

  const eligibleBoardRides = params.forScoring ? [] : params.mode === "remaining" ? boardRides : boardRides.filter((r) => r.is_pinned);
  const fixedRides = eligibleBoardRides
    .map((r) => boardRideToFixedRide(r, weekStartMs))
    .filter((f): f is FixedRide => f !== null);

  const fixedRequestIds = new Set(fixedRides.flatMap((f) => f.servedRequestIds));
  const openRequests = params.forScoring
    ? allRequests.filter((r) => !["draft", "withdrawn", "cancelled"].includes(r.status))
    : selectOpenRequests(allRequests, fixedRequestIds);

  // Rides a 'full' re-solve may replace: current, non-pinned board rides
  // (i.e. everything not in `fixedRides`). Used both for continuity
  // (`previousAssignments`) and for the confirm-dialog diff
  // (`computeFullResolveDiff`). Meaningless in 'remaining' mode (nothing is
  // ever replaced there).
  const replaceableRides = params.mode === "full" ? boardRides.filter((r) => !r.is_pinned) : [];
  const previousAssignments: Pick<Assignment, "servedRequestIds" | "carId">[] | undefined =
    params.mode === "full"
      ? replaceableRides
          .map((r) => boardRideToFixedRide(r, weekStartMs))
          .filter((f): f is FixedRide => f !== null)
          .map((f) => ({ servedRequestIds: f.servedRequestIds, carId: f.carId }))
      : undefined;

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
    previousAssignments,
    now: () => Date.now(),
  });

  return {
    input,
    weekStartMs,
    policyVersionId: params.policy.policyVersionId,
    requestsById: new Map(allRequests.map((r) => [r.id, r])),
    replaceableRides,
    boardRides,
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
 * applying (ARCHITECTURE.md §12 item 16); `apply_solver_result` also
 * recomputes an independent `week_state_fingerprint()` server-side
 * (`supabase/migrations/20260907092600_apply_solver_result_staleness.sql`)
 * and compares it against the fingerprint recorded at preview time, so a
 * change under the Sadran between preview and apply is caught server-side
 * too, not just by this client-only hash.
 */
export function hashSolverInput(input: SolverInput): string {
  const canonical = JSON.stringify({
    requests: [...input.requests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    fixedRides: [...input.fixedRides]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((f) => ({ id: f.id, carId: f.carId, window: f.window, approvedBufferAfterSlots: f.approvedBufferAfterSlots })),
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
  /**
   * `'full'`: a re-solve of the whole week — `apply_solver_result` may
   * replace every non-pinned solver-made ride of the week with this
   * payload's own `rides` (SOLVER.md §5.1). `'remaining'`: the primary
   * "Solve" action ("שבץ בקשות פתוחות") — every existing ride is already a
   * `fixedRide` constraint the solver never touched (`gatherSolverContext`'s
   * `mode: 'remaining'`), so the RPC must only ever *add* these new rides,
   * never delete anything (owner bug report #5:
   * supabase/migrations/20260907093100_apply_solver_result_remaining_mode.sql).
   */
  mode: "full" | "remaining";
}

/**
 * Shapes a `SolverOutput` into the `apply_solver_result`/`record_solver_preview`
 * jsonb payload. Only `source: 'solver'` assignments are included as new
 * rides — fixed/pinned assignments are already the rows in `rides` and
 * `apply_solver_result` only ever deletes `status = 'draft' and not
 * is_pinned` (in `'full'` mode only) before inserting these, so re-sending a
 * pinned ride would be redundant (and is intentionally omitted). Unmet
 * requests are set to `waitlisted`/`WAITLISTED_NO_CAR` uniformly rather than
 * one of several more specific reason codes (`UNMET_NO_RELAY_PARTNER`,
 * `UNMET_PASSENGER_NO_HOST`, …) the solver itself produces — CLAUDE.md hard
 * rule 3 confines new Hebrew to three places, and `WAITLISTED_NO_CAR` is
 * already seeded there (`he.statusReason.WAITLISTED_NO_CAR`); the board's
 * unmet list still shows the solver's own precise Hebrew `reason` string
 * alongside it (SOLVER.md §2, `UnmetRequest.reason`), so no information is
 * actually lost to the Sadran, only the persisted `status_reason` column is
 * coarser.
 *
 * Because `gatherSolverContext` now reopens every request whose current
 * ride is not fixed (see this file's header comment), every request that a
 * re-solve is allowed to touch appears in exactly one of
 * `solverAssignments`/`output.unmet` — so this payload's `rides` +
 * `request_statuses` together account for every request a `'full'` apply is
 * about to affect, and nothing is left pointing at a ride that no longer
 * exists.
 */
export function buildApplyPayload(params: {
  output: SolverOutput;
  weekStartMs: number;
  policyVersionId: string;
  startedAtMs: number;
  finishedAtMs: number;
  inputHash: string;
  requestsById: Map<string, RequestRow>;
  /** See `ApplyPayload.mode`. Defaults to `'full'` (every existing caller before this bug-fix pass meant full). */
  mode?: "full" | "remaining";
}): ApplyPayload {
  const { output, weekStartMs, policyVersionId, startedAtMs, finishedAtMs, inputHash, requestsById, mode = "full" } = params;

  const solverAssignments = output.assignments.filter((a) => a.source === "solver");
  const rides: ApplyPayloadRide[] = solverAssignments.map((a) => {
    const driverMemberId =
      a.driverMemberId ?? (a.driverRequestId ? requestsById.get(a.driverRequestId)?.requester_id : undefined) ?? "";
    const roundedEnd = slotToIso(a.window.end, weekStartMs);
    const exactEnd = a.legs.filter((leg) => leg.leg === "return" || leg.leg === "both")
      .map((leg) => requestsById.get(leg.requestId)?.return_at)
      .find((end): end is string => !!end && Date.parse(roundedEnd) - Date.parse(end) === 60_000);
    return {
      car_id: a.carId,
      starts_at: slotToIso(a.window.start, weekStartMs),
      ends_at: exactEnd ?? roundedEnd,
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
    mode,
  };
}

/**
 * `apply_solver_result`'s structured, atomic-apply summary
 * (supabase/migrations/20260907093300_apply_solver_result_summary.sql) —
 * shown in the result toast/sheet per the bug-fix pass requirement that an
 * apply never be silently partial. `unassigned_requests` are the requests
 * this apply left (or put) in `waitlisted` — i.e. `output.unmet` translated
 * back through the RPC, for the caller to display without recomputing it.
 */
export interface ApplySolverResultSummary {
  run_id: string;
  inserted: number;
  deleted: number;
  unchanged: number;
  unassigned_requests: string[];
  /** Multi-day requests ("series", REQ §13.77) skipped because no car was free for the whole span. */
  skippedSeries?: { series_id: string; reason: string }[];
}

/** One ride a `'full'` re-solve would change or remove, for the confirm dialog's "by label" listing. */
export interface FullResolveDiffRide {
  rideId: string;
  /** `"<car> <dep>–<ret>"`-style label — callers already have `rideLabel.ts` for the exact board formatting; this is the plain fallback. */
  label: string;
  carId: string;
  startsAt: string;
  endsAt: string;
}

export interface FullResolveDiff {
  /** Non-pinned rides that exist now and would be deleted by this apply (`gatherSolverContext`'s `replaceableRides`). */
  changedOrRemovedRides: FullResolveDiffRide[];
  /** How many currently-assigned/merged requests would end up `waitlisted` (lose their assignment) if applied. */
  requestsLosingAssignment: number;
}

/**
 * Computes what a `'full'` re-solve (mode `'full'`, `gatherSolverContext` +
 * `runSolve`) would change, for the "Re-solve the whole week" confirm
 * dialog required after the owner's testing: "listing exactly which rides
 * would change/disappear (by label) and how many requests would lose an
 * assignment" (docs/UX_FLOWS.md §19). Pure — takes the already-gathered
 * `SolverContext.replaceableRides` and the freshly computed `SolverOutput`,
 * does not refetch anything.
 */
export function computeFullResolveDiff(context: SolverContext, output: SolverOutput): FullResolveDiff {
  const newRequestIdsByCar = new Map<string, Set<string>>();
  for (const a of output.assignments) {
    if (a.source !== "solver") continue;
    const set = newRequestIdsByCar.get(a.carId) ?? new Set<string>();
    for (const id of a.servedRequestIds) set.add(id);
    newRequestIdsByCar.set(a.carId, set);
  }

  const changedOrRemovedRides: FullResolveDiffRide[] = [];
  const previouslyServedRequestIds = new Set<string>();
  for (const ride of context.replaceableRides) {
    const served = servedOf(ride);
    for (const s of served) previouslyServedRequestIds.add(s.request_id as string);
    // Every replaceable ride is unconditionally deleted and reinserted from
    // scratch by 'full' mode (SOLVER.md §5.1) — even one that would be
    // recreated byte-identical is still a delete+insert, so it is always
    // listed as "would change" for the confirm dialog's purposes.
    changedOrRemovedRides.push({
      rideId: ride.id as string,
      label: `${ride.car_id ?? ""} ${ride.starts_at ?? ""}–${ride.ends_at ?? ""}`,
      carId: ride.car_id as string,
      startsAt: ride.starts_at as string,
      endsAt: ride.ends_at as string,
    });
  }

  const unmetRequestIds = new Set(output.unmet.map((u) => u.requestId));
  let requestsLosingAssignment = 0;
  for (const id of previouslyServedRequestIds) {
    if (unmetRequestIds.has(id)) requestsLosingAssignment += 1;
  }

  return { changedOrRemovedRides, requestsLosingAssignment };
}
