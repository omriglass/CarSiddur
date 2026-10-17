import { describe, expect, it } from "vitest";

import { slotToIso } from "./geometry";
import { planBSwitchPrefill, type PlanBSwitchSuggestion } from "./planBSwitch";

const WEEK = Date.UTC(2026, 9, 11, 0, 0);
const base = { requestId: "U", otherRequestId: "P", carId: "c1", window: { start: 10, end: 20 }, reasonCode: "SUGGEST_PLAN_B_SWITCH", reason: "x", cost: 0, confidence: 0.4 };

describe("planBSwitchPrefill (REQ item 136 g)", () => {
  it("alternative: a proposal for P (not U) with P's plan-B cars and times", () => {
    const s = { ...base, kind: "planBSwitch", fallback: "alternative", alternative: { carId: "c2", returnCarId: "c3", departSlot: 4, returnSlot: 40 } } as PlanBSwitchSuggestion;
    expect(planBSwitchPrefill(s, WEEK)).toEqual({
      requestId: "P", rideId: null, type: "alternative",
      payload: { car_id: "c2", return_car_id: "c3", depart_at: slotToIso(4, WEEK), return_at: slotToIso(40, WEEK) },
    });
  });
  it("alternative without a return keeps the payload minimal; without placement data there is no proposal", () => {
    const s = { ...base, kind: "planBSwitch", fallback: "alternative", alternative: { carId: "c2", departSlot: 4 } } as PlanBSwitchSuggestion;
    expect(planBSwitchPrefill(s, WEEK)?.payload).toEqual({ car_id: "c2", depart_at: slotToIso(4, WEEK) });
    expect(planBSwitchPrefill({ ...s, alternative: undefined }, WEEK)).toBeNull();
  });
  it("manage: an external proposal for P with the own-arrangement hint", () => {
    const s = { ...base, kind: "planBSwitch", fallback: "manage" } as PlanBSwitchSuggestion;
    expect(planBSwitchPrefill(s, WEEK)).toEqual({ requestId: "P", rideId: null, type: "external", payload: { hint: "private" } });
  });
});
