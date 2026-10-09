// The derived "what the Sadran will see" line under a time (UX_FLOWS §3.4a). A drive stretched by
// rush hours (REQ §13.113) reads "כ־56 דק׳ נסיעה — הערכה בלבד"; rush hours themselves are never named.
import { he, tv } from "@/i18n/he";

import type { AnchorEstimate } from "../../../timeAnchors";

export function estimateLine(estimate: AnchorEstimate): string {
  const minutes = estimate.approx ? tv("requestSentence.estimateApprox", { minutes: String(estimate.minutes) }) : String(estimate.minutes);
  const line = tv(`requestSentence.estimate.${estimate.kind}` as const, { time: estimate.time, minutes });
  return estimate.approx ? `${line} — ${he.requestSentence.estimateNote}` : line;
}
