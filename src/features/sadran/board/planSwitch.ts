// Plan-B switch eligibility, shared by the ride sheet button and the unplaced card's "⋮" menu (kept out of the
// component file for react-refresh).
import type { RequestAlternativeEmbed } from "../api";

export interface PlanSwitchRequest {
  id: string;
  version: number | null | undefined;
  fallback?: string | null;
  alternative?: RequestAlternativeEmbed | null;
  served_by_alternative?: boolean | null;
  series_id?: string | null;
  plan_b_parent_id?: string | null;
  depart_at?: string | null;
  return_at?: string | null;
}

/** Does the request have a plan B the Sadran may switch to/from? */
export function canSwitchPlan(request: PlanSwitchRequest): boolean {
  return request.fallback === "alternative" && !!request.alternative && !request.series_id && !request.plan_b_parent_id && request.version != null;
}
