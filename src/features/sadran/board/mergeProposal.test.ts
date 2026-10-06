import { describe, expect, it } from "vitest";

import { makeHop } from "@/lib/rideRoute";

import { addedGuestsOf, combineMergeLegs, defaultMergeLeg, mergeLegForCard, mergeLegOptions, mergePayloadFromLegs, mergePayloadLegs, mergePayload, mergePayloadLeg, previewMerge } from "./mergeProposal";

import type { BoardRide, WeekRequestRow } from "../api";

const hop = makeHop([
  { fromId: "H", toId: "D", travelMinutes: 60 },
  { fromId: "H", toId: "T", travelMinutes: 20 },
  { fromId: "T", toId: "D", travelMinutes: 45 },
]);

const host = {
  id: "ride", starts_at: "2026-10-11T04:15:00.000Z", ends_at: "2026-10-11T07:00:00.000Z",
  origin_id: "H", origin_name: "Home", destination_id: "D", destination_name: "Dest", route: [],
} as unknown as BoardRide;

const request = (patch: Partial<WeekRequestRow>) => ({
  id: "r2", trip_shape: "one_way_to", origin_id: "T", origin_text: null, origin_resolved_name: "Station",
  destination_id: "D", destination_text: null, destination_resolved_name: "Dest",
  depart_at: "2026-10-11T04:00:00.000Z", return_at: null, requester_full_name: "Dana", ...patch,
}) as unknown as WeekRequestRow;

describe("mergeLegOptions", () => {
  it("presets and hides the choice for a one-leg request", () => {
    expect(mergeLegOptions({ trip_shape: "one_way_to" })).toEqual({ preset: "out", choices: ["out"] });
    expect(mergeLegOptions({ trip_shape: "one_way_from" })).toEqual({ preset: "return", choices: ["return"] });
  });
  it("offers out / both for a request with a pickup", () => {
    expect(mergeLegOptions({ trip_shape: "round_trip" })).toEqual({ preset: null, choices: ["out", "both"] });
    expect(defaultMergeLeg({ trip_shape: "round_trip" })).toBe("out");
  });
});

describe("mergePayload", () => {
  it("is legs only - never a window", () => {
    const payload = mergePayload("ride", "both");
    expect(payload).toEqual({ ride_id: "ride", legs: [{ ride_id: "ride", role: "passenger", leg: "both", car_mode: "passenger" }] });
    expect(payload).not.toHaveProperty("starts_at");
    expect(mergePayloadLeg(payload, { trip_shape: "one_way_to" })).toBe("both");
    expect(mergePayloadLeg({}, { trip_shape: "one_way_from" })).toBe("return");
  });
});

describe("previewMerge", () => {
  it("leaves earlier by the added driving, keeps the end and reports the estimated stop time", () => {
    const preview = previewMerge(host, request({}), "out", { hop, stopMinutes: 5, homeId: "H" })!;
    expect(preview.startsAt).toBe("2026-10-11T04:00:00.000Z");
    expect(preview.endsAt).toBe(host.ends_at);
    // ETA shown on the 15-minute grid (R2B25): 04:20Z -> 04:15Z
    expect(preview.boardEta).toBe("2026-10-11T04:15:00.000Z");
    // asked for 07:00 local (04:00Z), the ride gets there at ~07:15 local
    expect(preview.timeChanges).toBe(true);
  });

  it("reports no change when the estimate equals the requested time", () => {
    const preview = previewMerge(host, request({ depart_at: "2026-10-11T04:15:00.000Z" }), "out", { hop, stopMinutes: 5, homeId: "H" })!;
    expect(preview.timeChanges).toBe(false);
  });

  it("uses the home as the origin of a request without one", () => {
    const preview = previewMerge(host, request({ origin_id: null, origin_resolved_name: null }), "out", { hop, stopMinutes: 5, homeId: "H" })!;
    expect(preview.addedMinutes).toBe(0);
  });
});

describe("previewMerge return-only guest (R3B6)", () => {
  it("computes a stop time when the host has a single stored leg", () => {
    const preview = previewMerge(host, request({ trip_shape: "one_way_from", origin_id: "H", destination_id: "T", destination_resolved_name: "Station", depart_at: null, return_at: "2026-10-11T04:15:00.000Z" }), "return", { hop, stopMinutes: 5, homeId: "H" })!;
    expect(preview.boardLeg).not.toBeNull();
    expect(preview.boardEta).not.toBeNull();
  });
});

describe("addedGuestsOf", () => {
  it("lists everyone but the base (driver first, else the first served)", () => {
    const served = [
      { request_id: "p", role: "passenger", requester: "Pat" },
      { request_id: "d", role: "driver", requester: "Dov" },
      { request_id: "q", role: "passenger", requester: "Quin" },
    ];
    expect(addedGuestsOf("ride", served)).toEqual([{ requestId: "p", rideId: "ride", name: "Pat" }, { requestId: "q", rideId: "ride", name: "Quin" }]);
    expect(addedGuestsOf("ride", served.slice(0, 1))).toEqual([]);
    expect(addedGuestsOf("ride", [])).toEqual([]);
  });
});

describe("split merge helpers (REQ 102 d)", () => {
  it("a return-leg card offers return / both", () => {
    expect(mergeLegOptions({ trip_shape: "round_trip" }, "return").choices).toEqual(["return", "both"]);
    expect(mergeLegForCard({ trip_shape: "round_trip" }, "return")).toBe("return");
    expect(mergeLegOptions({ trip_shape: "round_trip" }, null).choices).toEqual(["out", "both"]);
  });
  it("extends an open draft with the other leg on another ride", () => {
    const result = combineMergeLegs([{ ride_id: "A", leg: "out" }], { ride_id: "B", leg: "return" });
    expect(result).toEqual({ legs: [{ ride_id: "A", leg: "out" }, { ride_id: "B", leg: "return" }], replaced: false });
    const payload = mergePayloadFromLegs(result.legs);
    expect(payload.ride_id).toBe("A");
    expect(mergePayloadLegs(payload)).toEqual(result.legs);
  });
  it("replaces a draft for the same leg, and collapses out+return on one ride to both", () => {
    expect(combineMergeLegs([{ ride_id: "A", leg: "out" }], { ride_id: "B", leg: "out" }).replaced).toBe(true);
    expect(combineMergeLegs([{ ride_id: "A", leg: "out" }], { ride_id: "A", leg: "return" }).legs).toEqual([{ ride_id: "A", leg: "both" }]);
  });
});
