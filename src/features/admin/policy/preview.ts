// Orchestrates the priority-policy editor's "test on last week" preview
// (docs/UX_FLOWS.md §5.8): loads one department's last live/archived week,
// builds a `SolverInput` via the shared `buildSolverInput` bridge, and
// re-scores/re-solves it once per policy (current vs. edited-but-unsaved).
//
// `normalize`/`scoreRequests` are deep-imported from `src/solver/slots.ts`
// and `src/solver/policy/engine.ts` rather than the `@/solver` barrel,
// which only re-exports `solve()` itself (whole-pipeline) — per-request
// scores aren't otherwise surfaced for served requests. Recorded as a
// deviation in UX_FLOWS.md §12 (stage 2c). Importing solver internals from
// the UI is allowed either way (CLAUDE.md/ui-dev.md: "importing the solver
// into the UI is fine; the reverse is not").

import { fetchCarsAll, fetchSeatConfigsForCars } from "../cars/api";
import { fetchDepartmentSettings } from "../departments/api";
import { fetchAllDestinations } from "../destinations/api";
import { fetchAllRideTypes } from "../rideTypes/api";
import { computeFlips, computeRankingDelta, type FlipRow, type RankingRow } from "./diff";
import { fetchFairnessStats, fetchLastTestableWeek, fetchWeekRequests, type PolicyRuleConfig } from "./api";

import { buildSolverInput } from "@/features/solverBridge/buildSolverInput";
import { scoreRequests } from "@/solver/policy/engine";
import { normalize } from "@/solver/slots";
import { solve } from "@/solver";

import type { Policy } from "@/solver";

export interface PolicyPreviewResult {
  weekStart: string;
  requestCount: number;
  rankingRows: RankingRow[];
  flips: FlipRow[];
}

function lookbackWeeksOf(rules: PolicyRuleConfig[]): number {
  const fairnessRule = rules.find((r) => r.type === "fairness");
  const params = fairnessRule?.params as { lookbackWeeks?: number } | undefined;
  return params?.lookbackWeeks ?? 3;
}

export async function runPolicyPreview(params: {
  departmentId: string;
  homeDestinationId: string;
  oldRules: PolicyRuleConfig[];
  newRules: PolicyRuleConfig[];
}): Promise<PolicyPreviewResult | null> {
  const { departmentId, homeDestinationId, oldRules, newRules } = params;

  const weekStart = await fetchLastTestableWeek(departmentId);
  if (!weekStart) return null;

  const [departmentSettings, requests, allCars, destinations, rideTypes] = await Promise.all([
    fetchDepartmentSettings(departmentId),
    fetchWeekRequests(departmentId, weekStart),
    fetchCarsAll(),
    fetchAllDestinations(departmentId),
    fetchAllRideTypes(departmentId),
  ]);

  const cars = allCars.filter((c) => c.department_id === departmentId && c.status !== "retired");
  const seatConfigsByCarId = await fetchSeatConfigsForCars(cars.map((c) => c.id));
  const rideTypeCodesById = Object.fromEntries(rideTypes.map((rt) => [rt.id, rt.code]));

  const [fairnessOld, fairnessNew] = await Promise.all([
    fetchFairnessStats(departmentId, weekStart, lookbackWeeksOf(oldRules)),
    fetchFairnessStats(departmentId, weekStart, lookbackWeeksOf(newRules)),
  ]);

  const oldPolicy: Policy = { id: "current", version: 0, rules: oldRules };
  const newPolicy: Policy = { id: "draft", version: 0, rules: newRules };

  const baseArgs = {
    weekStart,
    homeDestinationId,
    departmentSettings,
    requests,
    rideTypeCodesById,
    cars,
    seatConfigsByCarId,
    destinations,
  };

  const inputOld = buildSolverInput({ ...baseArgs, policy: oldPolicy, fairness: fairnessOld });
  const inputNew = buildSolverInput({ ...baseArgs, policy: newPolicy, fairness: fairnessNew });

  const { normalized } = normalize(inputOld);
  const scoresOld = scoreRequests(inputOld, normalized).scores;
  const scoresNew = scoreRequests(inputNew, normalized).scores;

  const rankingRows = computeRankingDelta(
    new Map([...scoresOld.entries()].map(([id, s]) => [id, s.total])),
    new Map([...scoresNew.entries()].map(([id, s]) => [id, s.total])),
  );

  const outputOld = solve(inputOld);
  const outputNew = solve(inputNew);
  const servedOld = new Set(outputOld.assignments.flatMap((a) => a.servedRequestIds));
  const servedNew = new Set(outputNew.assignments.flatMap((a) => a.servedRequestIds));
  const flips = computeFlips(servedOld, servedNew);

  return { weekStart, requestCount: requests.length, rankingRows, flips };
}
