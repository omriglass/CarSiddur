import { fetchDepartments } from "@/features/siddur/api";
import { AppError } from "@/lib/rpc";
import { he } from "@/i18n/he";
import type { Json } from "@/integrations/supabase/types";
import { fetchActivePolicy, fetchPolicyOptions, fetchPublishFingerprint, publishSiddur, type PublicationOptions } from "../api";
import { gatherSolverContext, servedOf } from "../applySolve";
import { calculateProfileScores, summarizePolicyScore } from "./profileScores";

export async function publishWithScores(departmentId: string, weekStart: string, options: PublicationOptions = {}): Promise<string> {
  const before = await fetchPublishFingerprint(departmentId, weekStart);
  const [activePolicy, policies, departments] = await Promise.all([fetchActivePolicy(departmentId), fetchPolicyOptions(departmentId), fetchDepartments()]);
  const homeDestinationId = departments.find((d) => d.id === departmentId)?.home_destination_id;
  // Policy-score snapshots are reporting data, not a publication precondition.
  // A week may contain legacy or incomplete requests that cannot be scored
  // today; the schedule must still be publishable and can be scored later.
  // Each policy is scored independently: one policy failing (e.g. a stale/removed rule
  // type) must not blank out every other policy's snapshot, so the try/catch is per
  // policy, not around the whole loop -- and a failure is logged, never silent.
  let policyScores: ReturnType<typeof summarizePolicyScore>[] = [];
  if (activePolicy && policies.length && homeDestinationId) {
    const settled = await Promise.all(policies.map(async (policy) => {
      try {
        const context = await gatherSolverContext({ departmentId, weekStart, homeDestinationId, policy, mode: "remaining", forScoring: true });
        const served = new Set(context.boardRides.filter((r) => r.status !== "cancelled" && !r.needs_driver).flatMap((r) => servedOf(r).map((s) => s.request_id!)));
        return summarizePolicyScore(policy, calculateProfileScores(context.input, served));
      } catch (error) {
        console.error(`[publishWithScores] policy ${policy.policyId} failed to score; omitting it from this snapshot`, error);
        return null;
      }
    }));
    policyScores = settled.filter((score): score is ReturnType<typeof summarizePolicyScore> => score !== null);
  }
  const activeScores = activePolicy
    ? policyScores.find((p) => p.policy_version_id === activePolicy.policyVersionId)?.profiles ?? []
    : [];
  if (before !== await fetchPublishFingerprint(departmentId, weekStart)) throw new AppError("stale_input", he.errors.staleInput);
  return publishSiddur(departmentId, weekStart, activeScores as unknown as Json, before, policyScores as unknown as Json, options);
}
