import { scoreRequests, type ScoreBreakdown } from "@/solver/policy/engine";
import { normalize } from "@/solver/slots";
import { pairRelays } from "@/solver/relay";
import type { SolverInput } from "@/solver";

export interface ProfileScore {
  profile_id: string;
  request_count: number;
  served_count: number;
  priority_total: number;
  served_priority_total: number;
  requests: { request_id: string; score: number; breakdown: ScoreBreakdown["perRule"]; served: boolean }[];
}

export interface PolicyBoardScore {
  policy_id: string;
  policy_version_id: string;
  policy_name: string;
  request_count: number;
  served_count: number;
  priority_total: number;
  served_priority_total: number;
  alignment_ratio: number | null;
  profiles: ProfileScore[];
}

export function summarizePolicyScore(policy: { policyId: string; policyVersionId: string; name: string }, profiles: ProfileScore[]): PolicyBoardScore {
  const total = profiles.reduce((sum, profile) => sum + profile.priority_total, 0);
  const served = profiles.reduce((sum, profile) => sum + profile.served_priority_total, 0);
  return {
    policy_id: policy.policyId, policy_version_id: policy.policyVersionId, policy_name: policy.name,
    request_count: profiles.reduce((sum, p) => sum + p.request_count, 0),
    served_count: profiles.reduce((sum, p) => sum + p.served_count, 0),
    priority_total: Math.round(total * 1e6) / 1e6,
    served_priority_total: Math.round(served * 1e6) / 1e6,
    alignment_ratio: total > 0 ? Math.round(served / total * 1e6) / 1e6 : null,
    profiles,
  };
}

/** Re-score the original requests; final assignments only determine who was served. */
export function calculateProfileScores(input: SolverInput, servedRequestIds: ReadonlySet<string>): ProfileScore[] {
  const scoringInput = { ...input, fixedRides: [] };
  const { normalized } = normalize(scoringInput);
  const relayEligible = normalized.filter((r) => r.legs[0]?.side !== "both" && !r.isPassengerOnly);
  const { pairs } = pairRelays(relayEligible, input.cars);
  const byId = new Map(normalized.map((r) => [r.id, r]));
  const pairPeople = new Map<string, number>();
  for (const pair of pairs) {
    const requests = [byId.get(pair.outRequestId), byId.get(pair.returnRequestId)];
    const people = requests.reduce((sum, r) => sum + (r ? r.passengers.adults + r.passengers.childSeats + r.passengers.boosters - 1 : 0), 0);
    for (const r of requests) if (r) pairPeople.set(r.id, people);
  }
  const { scores, warnings } = scoreRequests(scoringInput, normalized, pairPeople);
  if (warnings.length || scores.size !== input.requests.length) throw new Error("invalid_publication_scores");
  const profiles = new Map<string, ProfileScore>();
  for (const request of [...input.requests].sort((a, b) => a.id.localeCompare(b.id))) {
    const score = scores.get(request.id)!;
    const served = servedRequestIds.has(request.id);
    const profile = profiles.get(request.memberId) ?? {
      profile_id: request.memberId, request_count: 0, served_count: 0,
      priority_total: 0, served_priority_total: 0, requests: [],
    };
    profile.request_count++;
    profile.served_count += Number(served);
    profile.priority_total = Math.round((profile.priority_total + score.total) * 1e6) / 1e6;
    profile.served_priority_total = Math.round((profile.served_priority_total + (served ? score.total : 0)) * 1e6) / 1e6;
    profile.requests.push({ request_id: request.id, score: score.total, breakdown: score.perRule, served });
    profiles.set(profile.profile_id, profile);
  }
  return [...profiles.values()].sort((a, b) => a.profile_id.localeCompare(b.profile_id));
}
