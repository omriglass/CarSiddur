// REQUIREMENTS item 136 (g): the solver's `planBSwitch` suggestion is a proposal TO THE OTHER member (P, a placed
// request with a plan B or "אסתדר"), never to the unmet request the card belongs to. Pure; the board's
// `handleUnmetAction` hands the result to `goToComposer` (draft / send choice).
import { slotToIso } from "./geometry";
import type { Suggestion } from "@/solver";

import type { ComposerPrefill } from "./draftInput";

export type PlanBSwitchSuggestion = Extract<Suggestion, { kind: "planBSwitch" }>;

/** "אסתדר" is stored as an external proposal with the generic "own arrangement" hint (`external.hint.private`). */
export const MANAGE_EXTERNAL_HINT = "private";

export function planBSwitchPrefill(suggestion: PlanBSwitchSuggestion, weekStartMs: number): ComposerPrefill | null {
  const base = { requestId: suggestion.otherRequestId, rideId: null };
  if (suggestion.fallback === "manage") return { ...base, type: "external", payload: { hint: MANAGE_EXTERNAL_HINT } };
  const alt = suggestion.alternative;
  if (!alt) return null;
  return {
    ...base, type: "alternative",
    payload: {
      car_id: alt.carId,
      ...(alt.returnCarId ? { return_car_id: alt.returnCarId } : {}),
      depart_at: slotToIso(alt.departSlot, weekStartMs),
      ...(alt.returnSlot != null ? { return_at: slotToIso(alt.returnSlot, weekStartMs) } : {}),
    },
  };
}
