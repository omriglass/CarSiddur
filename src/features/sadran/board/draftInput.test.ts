import { describe, expect, it } from "vitest";

import { buildDraftInput, type DraftInputContext } from "./draftInput";
import type { BoardRide, WeekRequestRow } from "../api";

const request = {
  id: "req1", requester_id: "u1", requester_full_name: "Dana Cohen", trip_shape: "round_trip",
  depart_at: "2026-10-11T06:00:00.000Z", return_at: "2026-10-11T10:00:00.000Z",
  origin_id: null, origin_text: null, origin_resolved_name: null, destination_id: "d1", destination_text: null,
} as unknown as WeekRequestRow;
const host = { id: "h1", car_id: "c1", driver_id: "u2", driver_name: "Dov", starts_at: "2026-10-11T05:00:00.000Z", ends_at: "2026-10-11T09:00:00.000Z", served: [] } as unknown as BoardRide;
const ctx: DraftInputContext = {
  requests: [request], rides: [host], templates: [{ variant: "shift", body: "hi {{firstName}} {{newDepart}} {{link}}" }],
  destinations: [{ id: "d1", name: "Haifa" }], cars: [{ id: "c1", name: "Car 1" }], sadranName: "S", homeDestinationId: "home",
};

describe("buildDraftInput", () => {
  it("shift: same payload keys as the composer and a rendered preview that keeps the link token", () => {
    const result = buildDraftInput({ requestId: "req1", rideId: null, type: "shift", payload: { car_id: "c1", depart_at: "2026-10-11T07:00:00.000Z", return_at: "2026-10-11T10:00:00.000Z" } }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.payload).toMatchObject({ car_id: "c1", depart_at: "2026-10-11T07:00:00.000Z" });
    expect(result.input.reasonHe).toContain("Dana");
    expect(result.input.reasonHe).toContain("{{link}}");
    expect(result.input.partyProfileIds).toEqual([]);
  });
  it("shift with no usable times is refused", () => {
    expect(buildDraftInput({ requestId: "req1", rideId: null, type: "shift", payload: {} }, { ...ctx, requests: [{ ...request, depart_at: null, return_at: null } as WeekRequestRow] }).ok).toBe(false);
  });
  it("merge needs a host ride and adds the host driver as a party", () => {
    const prefill = { requestId: "req1", rideId: "h1", type: "merge" as const, payload: { ride_id: "h1" } };
    const result = buildDraftInput(prefill, ctx);
    expect(result.ok && result.input.partyProfileIds).toEqual(["u2"]);
    // REQ §13.94: legs only, never a window - the host keeps its start.
    expect(result.ok && result.input.payload).toMatchObject({ ride_id: "h1", legs: [{ ride_id: "h1", role: "passenger", leg: "both" }] });
    expect(result.ok && result.input.payload).not.toHaveProperty("starts_at");
    // REQ §13.100 c: a ride that still needs a driver is a valid merge host; a missing host is not.
    expect(buildDraftInput(prefill, { ...ctx, rides: [{ ...host, driver_id: null } as BoardRide] }).ok).toBe(true);
    expect(buildDraftInput(prefill, { ...ctx, rides: [] }).ok).toBe(false);
  });
  it("unknown request is refused; external waive is stored as deny", () => {
    expect(buildDraftInput({ requestId: "nope", rideId: null, type: "deny", payload: {} }, ctx).ok).toBe(false);
    const result = buildDraftInput({ requestId: "req1", rideId: null, type: "external", payload: { hint: "waive" } }, ctx);
    expect(result.ok && result.input.type).toBe("deny");
  });
});
