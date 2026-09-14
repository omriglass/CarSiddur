// src/features/sadran/board/useBoardPolicyScores.ts
//
// Live per-policy `alignment_ratio` for the board's policy chip (owner
// request, 2026-09-14): one number per policy option, recomputed whenever
// the selected policy or the board's own data (requests/rides/etc, "the
// board's assignments") changes. Purely informational — see
// `./policyScore.ts`'s header comment; nothing here is persisted.

import { useMemo } from "react";

import { boardPolicyScore } from "./policyScore";
import { buildSolverContextFromData } from "../applySolve";

import type { SolverContextRows } from "../applySolve";
import type { PolicyOption } from "../api";

/** `policyVersionId -> alignment_ratio` (or `null` when that policy could not be scored). */
export type BoardPolicyScores = Record<string, number | null>;

export interface UseBoardPolicyScoresParams {
  departmentId: string;
  weekStart: string;
  homeDestinationId: string | null | undefined;
  policyOptions: readonly PolicyOption[];
  /**
   * Every row `buildSolverContextFromData` needs, already loaded by the
   * board's own query hooks (the same bundle `BoardScreen`'s `computePreview`
   * passes it) — `null` while any of them is still loading, in which case
   * this hook returns `{}` rather than guessing at a partial score.
   */
  rows: SolverContextRows | null;
}

/**
 * Scores every policy option against the board's current assignments,
 * `buildSolverContextFromData` (synchronous, already-loaded data) per
 * policy rather than a fresh `gatherSolverContext` fetch — cheap enough
 * (milliseconds) to run on every render this way. `forScoring: true` mirrors
 * `publishWithScores.ts`'s own scoring pass (every submitted-or-later
 * request counts toward the denominator, not just the still-open ones a
 * live "remaining" solve would touch).
 *
 * Never throws into render: each policy is scored independently and a
 * failure (a stale/removed rule type, malformed params) is caught, logged,
 * and reported as `null` for that policy alone — the same tolerance
 * `publishWithScores.ts` already applies per policy.
 */
export function useBoardPolicyScores({ departmentId, weekStart, homeDestinationId, policyOptions, rows }: UseBoardPolicyScoresParams): BoardPolicyScores {
  return useMemo<BoardPolicyScores>(() => {
    if (!rows || !homeDestinationId) return {};
    const scores: BoardPolicyScores = {};
    for (const policy of policyOptions) {
      try {
        const context = buildSolverContextFromData(
          {
            departmentId,
            weekStart,
            homeDestinationId,
            policy: {
              policyId: policy.policyId,
              policyVersionId: policy.policyVersionId,
              versionNo: policy.versionNo,
              rules: policy.rules,
              settings: policy.settings,
            },
            mode: "remaining",
            forScoring: true,
          },
          rows,
        );
        scores[policy.policyVersionId] = boardPolicyScore(context, rows.boardRides);
      } catch (error) {
        console.error(`[useBoardPolicyScores] policy ${policy.policyVersionId} failed to score`, error);
        scores[policy.policyVersionId] = null;
      }
    }
    return scores;
    // `rows` bundles several already-memoized query results into one fresh object
    // literal per `BoardScreen` render, so depending on it directly would recompute
    // on every render regardless of whether any of its fields actually changed —
    // this hook is cheap enough (milliseconds) that this is an acceptable tradeoff
    // for not having to keep this dependency list in sync with `SolverContextRows`.
  }, [departmentId, weekStart, homeDestinationId, policyOptions, rows]);
}
