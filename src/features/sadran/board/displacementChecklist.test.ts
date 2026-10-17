import { describe, expect, it } from "vitest";

import { buildDisplacementSteps, checklistRideIds, isDisplacementSuggestion, relocationRequestId, type ChecklistRide, type DisplacementSuggestion } from "./displacementChecklist";

import type { Suggestion } from "@/solver";

const ride = (id: string, carId: string, requestId: string, status = "confirmed"): ChecklistRide =>
  ({ id, car_id: carId, status, served: [{ request_id: requestId }] } as unknown as ChecklistRide);

const suggestion: DisplacementSuggestion = {
  kind: "shiftWithinFlex", requestId: "head", reasonCode: "SUGGEST_SERIES_DISPLACE", reason: "", cost: 1, confidence: 1,
  carId: "tosia", window: { start: 100, end: 400 }, shift: { departureMin: 0, returnMin: 0 },
  relocations: [
    { rideId: "ride:b", fromCarId: "tosia", toCarId: "mazda", window: { start: 120, end: 160 } },
    { rideId: "ride:a", fromCarId: "tosia", toCarId: "", window: { start: 110, end: 150 } },
  ],
};

describe("displacement checklist", () => {
  it("recognizes only shiftWithinFlex with relocations", () => {
    expect(isDisplacementSuggestion(suggestion)).toBe(true);
    expect(isDisplacementSuggestion({ ...suggestion, relocations: [] })).toBe(false);
    expect(isDisplacementSuggestion({ ...suggestion, kind: "shiftBeyondFlex" } as unknown as Suggestion)).toBe(false);
  });
  it("maps a solver ride id to its request id", () => {
    expect(relocationRequestId({ rideId: "ride:abc" })).toBe("abc");
  });
  it("orders unplace, move, place and starts all undone", () => {
    const steps = buildDisplacementSteps(suggestion, [ride("RA", "tosia", "a"), ride("RB", "tosia", "b")]);
    expect(steps.map((s) => [s.kind, s.requestId, s.done])).toEqual([["unplace", "a", false], ["move", "b", false], ["place", "head", false]]);
    expect([...checklistRideIds(steps)].sort()).toEqual(["RA", "RB"]);
  });
  it("marks steps done from the current rides", () => {
    const rides = [ride("RB", "mazda", "b"), ride("RH", "tosia", "head"), ride("RA", "tosia", "a", "cancelled")];
    const steps = buildDisplacementSteps(suggestion, rides);
    expect(steps.map((s) => s.done)).toEqual([true, true, true]);
  });
  it("a move is not done while the ride still sits on the old car", () => {
    const steps = buildDisplacementSteps(suggestion, [ride("RB", "tosia", "b"), ride("RB2", "mazda", "b")]);
    expect(steps.find((s) => s.kind === "move")?.done).toBe(false);
  });
  it("uses the given target request (series head)", () => {
    const steps = buildDisplacementSteps(suggestion, [ride("R1", "tosia", "other")], "other");
    expect(steps.at(-1)).toMatchObject({ kind: "place", requestId: "other", done: true });
  });
});
