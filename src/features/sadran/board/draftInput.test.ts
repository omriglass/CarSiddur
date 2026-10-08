import { describe, expect, it } from "vitest";

import { alternativeTextInput, buildDraftInput, type DraftInputContext } from "./draftInput";
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

describe("buildDraftInput: alternative (REQ §13.112 a)", () => {
  const altRequest = {
    ...request,
    alternative: { drop_place_id: "p1", drop_place_text: null, arrive_by: "2026-10-11T05:00:00.000Z", pickup: true, pickup_at: "2026-10-11T16:00:00.000Z", applied_at: null, drop_place: { name: "Harish" } },
  } as unknown as WeekRequestRow;
  const altCtx: DraftInputContext = { ...ctx, requests: [altRequest], templates: [{ variant: "alternative", body: "hi {{firstName}}: {{planLine}} {{link}}" }] };
  const prefill = { requestId: "req1", rideId: null, type: "alternative" as const, payload: { car_id: "c1", depart_at: "2026-10-11T04:30:00.000Z", return_at: "2026-10-11T16:30:00.000Z" } };

  it("creates an alternative draft with the cars and times and a text that speaks of the member's plan B", () => {
    const result = buildDraftInput(prefill, altCtx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.type).toBe("alternative");
    expect(result.input.payload).toEqual({ car_id: "c1", depart_at: "2026-10-11T04:30:00.000Z", return_at: "2026-10-11T16:30:00.000Z" });
    expect(result.input.reasonHe).toContain("Harish");
    expect(result.input.reasonHe).toContain("{{link}}");
    expect(result.input.partyProfileIds).toEqual([]);
  });
  it("is refused without a car or a departure", () => {
    expect(buildDraftInput({ ...prefill, payload: { car_id: "c1" } }, altCtx).ok).toBe(false);
  });
  it("alternativeTextInput reads the drop place name, falling back to free text", () => {
    expect(alternativeTextInput(altRequest)).toEqual({ dropPlace: "Harish", arriveBy: "2026-10-11T05:00:00.000Z", pickupAt: "2026-10-11T16:00:00.000Z" });
    expect(alternativeTextInput({ alternative: { drop_place_id: null, drop_place_text: "the junction", arrive_by: "x", pickup: false, pickup_at: null, applied_at: null } })).toEqual({ dropPlace: "the junction", arriveBy: "x", pickupAt: null });
    expect(alternativeTextInput({ alternative: null })).toBeUndefined();
    expect(alternativeTextInput(undefined)).toBeUndefined();
  });
});
