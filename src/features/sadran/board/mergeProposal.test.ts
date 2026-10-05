import { describe, expect, it } from "vitest";

import { makeHop } from "@/lib/rideRoute";

import { addedGuestsOf, defaultMergeLeg, mergeLegOptions, mergePayload, mergePayloadLeg, previewMerge } from "./mergeProposal";

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
  it("keeps the host start, extends the end and reports the estimated stop time", () => {
    const preview = previewMerge(host, request({}), "out", { hop, stopMinutes: 5, homeId: "H" })!;
    expect(preview.startsAt).toBe(host.starts_at);
    expect(preview.endsAt).toBe("2026-10-11T07:15:00.000Z");
    expect(preview.boardEta).toBe("2026-10-11T04:35:00.000Z");
    // asked for 07:00 local (04:00Z), the ride gets there at 07:35 local
    expect(preview.timeChanges).toBe(true);
  });

  it("reports no change when the estimate equals the requested time", () => {
    const preview = previewMerge(host, request({ depart_at: "2026-10-11T04:35:00.000Z" }), "out", { hop, stopMinutes: 5, homeId: "H" })!;
    expect(preview.timeChanges).toBe(false);
  });

  it("uses the home as the origin of a request without one", () => {
    const preview = previewMerge(host, request({ origin_id: null, origin_resolved_name: null }), "out", { hop, stopMinutes: 5, homeId: "H" })!;
    expect(preview.addedMinutes).toBe(0);
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
