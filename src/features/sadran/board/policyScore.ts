// src/features/sadran/board/policyScore.ts
//
// Live "policy score" preview for the Sadran board (owner request,
// 2026-09-14): the same weighted-coverage / `alignment_ratio` figure
// `publishWithScores.ts` computes and stores at publish time
// (`../publish/profileScores.ts`'s `calculateProfileScores` +
// `summarizePolicyScore`, DATA_MODEL.md §3.9) shown live next to the board's
// policy chip, purely informational — nothing here is persisted; the
// publish-time snapshot is still the only stored figure.

import { servedOf } from "../applySolve";
import { calculateProfileScores, summarizePolicyScore } from "../publish/profileScores";

import type { BoardRide } from "../api";
import type { SolverInput } from "@/solver";

/**
 * One policy's `alignment_ratio` against the board's *current* assignments
 * — mirrors `publishWithScores.ts`'s served-set logic exactly (a ride counts
 * as served when it is not cancelled and does not still need a driver), just
 * run against a `SolverInput` the caller already built for this policy
 * (`buildSolverContextFromData`) instead of a fresh `gatherSolverContext`
 * fetch. `null` when there is nothing to score (no requests at all, so
 * `summarizePolicyScore`'s total priority is 0) — never thrown; the only
 * inputs it reads (`context.input`, `boardRides`) are already-validated
 * solver data, so nothing here should throw, but a caller iterating several
 * policies should still catch per policy (see `useBoardPolicyScores`).
 */
export function boardPolicyScore(context: { input: SolverInput }, boardRides: readonly BoardRide[]): number | null {
  const servedRequestIds = new Set(
    boardRides
      .filter((r) => r.status !== "cancelled" && !r.needs_driver)
      .flatMap((r) => servedOf(r).map((s) => s.request_id as string)),
  );
  const profiles = calculateProfileScores(context.input, servedRequestIds);
  // Identity fields are irrelevant to the ratio itself; only used by
  // `summarizePolicyScore`'s return shape (which this function discards down
  // to just `alignment_ratio`).
  return summarizePolicyScore({ policyId: "", policyVersionId: "", name: "" }, profiles).alignment_ratio;
}
