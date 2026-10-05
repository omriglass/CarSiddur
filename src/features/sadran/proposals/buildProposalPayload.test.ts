import { describe, expect, it } from "vitest";

import { buildProposalPayload, isPlaceOnlyShift, resolveShiftTimes } from "./buildProposalPayload";

const request = { depart_at: "2026-10-11T07:00:00.000Z", return_at: "2026-10-11T12:00:00.000Z", trip_shape: "round_trip" };
const base = { prefillPayload: {}, request, rideId: null, effectiveReason: "r", externalHint: "cab" } as const;

describe("buildProposalPayload", () => {
  it("shift keeps prefill keys and the proposed times", () => {
    const payload = buildProposalPayload({ ...base, type: "shift", prefillPayload: { car_id: "c1" }, proposedDepartAt: request.depart_at, proposedReturnAt: request.return_at });
    expect(payload).toEqual({ car_id: "c1", depart_at: request.depart_at, return_at: request.return_at });
  });
  it("shift rejects a return before the departure and an empty change", () => {
    expect(buildProposalPayload({ ...base, type: "shift", proposedDepartAt: request.return_at, proposedReturnAt: request.depart_at })).toBeNull();
    expect(buildProposalPayload({ ...base, type: "shift" })).toBeNull();
  });
  it("a places/stops-only shift (ride-detail edit) carries no times", () => {
    const prefillPayload = { ride_id: "r1", origin_id: "o", stops: [{ leg: "out", place_id: "s" }] };
    expect(buildProposalPayload({ ...base, type: "shift", prefillPayload, proposedDepartAt: "2026-10-11T06:00:00Z" })).toEqual(prefillPayload);
    expect(isPlaceOnlyShift({ car_id: "c", origin_id: "o" })).toBe(false);
    expect(isPlaceOnlyShift({ depart_at: "x", stops: [] })).toBe(false);
    expect(isPlaceOnlyShift({})).toBe(false);
  });
  it("deny and external carry the reason", () => {
    expect(buildProposalPayload({ ...base, type: "deny" })).toEqual({ reason: "r" });
    expect(buildProposalPayload({ ...base, type: "external" })).toEqual({ hint: "cab", reason: "r" });
  });
  it("merge needs a ride and defaults legs from the trip shape", () => {
    expect(buildProposalPayload({ ...base, type: "merge" })).toBeNull();
    const payload = buildProposalPayload({ ...base, type: "merge", rideId: "h1", request: { ...request, trip_shape: "one_way_from" } });
    expect(payload).not.toHaveProperty("starts_at");
    expect(payload).toMatchObject({ ride_id: "h1", legs: [{ ride_id: "h1", leg: "return", role: "passenger" }] });
  });
  it("merge keeps the legs the board prepared", () => {
    const legs = [{ ride_id: "h1", role: "passenger", leg: "out", car_mode: "passenger" }];
    expect(buildProposalPayload({ ...base, type: "merge", rideId: "h1", prefillPayload: { legs } })?.legs).toBe(legs);
  });
  it("origin needs both ids", () => {
    expect(buildProposalPayload({ ...base, type: "origin", prefillPayload: { origin_id: "o" } })).toBeNull();
    expect(buildProposalPayload({ ...base, type: "origin", prefillPayload: { origin_id: "o", car_id: "c", extra: 1 } })).toEqual({ origin_id: "o", car_id: "c" });
  });
});

describe("resolveShiftTimes", () => {
  it("prefers the prefill and clamps a next-day return to 23:59 of the departure day", () => {
    const times = resolveShiftTimes({ depart_at: "2026-10-11T07:00:00.000Z", return_at: "2026-10-12T07:00:00.000Z" }, request);
    expect(times.departAt).toBe("2026-10-11T07:00:00.000Z");
    expect(times.returnAt).toBe("2026-10-11T20:59:00.000Z");
  });
  it("falls back to the request", () => {
    expect(resolveShiftTimes(undefined, request)).toEqual({ departAt: request.depart_at, returnAt: request.return_at });
  });
});

describe("shift payload never carries places", () => {
  it("strips place keys from a time/car shift", () => {
    const out = buildProposalPayload({
      type: "shift", prefillPayload: { car_id: "c", origin_id: "home", destination_id: "home" }, request: undefined, rideId: null,
      proposedDepartAt: "2026-09-13T06:00:00.000Z", proposedReturnAt: "2026-09-13T08:00:00.000Z", effectiveReason: "", externalHint: "",
    });
    expect(out).toEqual({ car_id: "c", depart_at: "2026-09-13T06:00:00.000Z", return_at: "2026-09-13T08:00:00.000Z" });
  });
});
