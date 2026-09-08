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
  let policyScores: ReturnType<typeof summarizePolicyScore>[] = [];
  if (activePolicy && policies.length && homeDestinationId) {
    try {
      policyScores = await Promise.all(policies.map(async (policy) => {
        const context = await gatherSolverContext({ departmentId, weekStart, homeDestinationId, policy, mode: "remaining", forScoring: true });
        const served = new Set(context.boardRides.filter((r) => r.status !== "cancelled" && !r.needs_driver).flatMap((r) => servedOf(r).map((s) => s.request_id!)));
        return summarizePolicyScore(policy, calculateProfileScores(context.input, served));
      }));
    } catch {
      // Persist an empty score snapshot rather than blocking the schedule.
      policyScores = [];
    }
  }
  const activeScores = activePolicy
    ? policyScores.find((p) => p.policy_version_id === activePolicy.policyVersionId)?.profiles ?? []
    : [];
  if (before !== await fetchPublishFingerprint(departmentId, weekStart)) throw new AppError("stale_input", he.errors.staleInput);
  return publishSiddur(departmentId, weekStart, activeScores as unknown as Json, before, policyScores as unknown as Json, options);
}
