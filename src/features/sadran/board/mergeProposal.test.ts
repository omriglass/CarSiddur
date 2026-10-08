import { describe, expect, it } from "vitest";

import { makeHop } from "@/lib/rideRoute";

import { addedGuestsOf, applyServerMergeTimes, combineMergeLegs, parseServerMergePreview, defaultMergeLeg, mergeLegForCard, mergeLegOptions, mergePayloadFromLegs, mergePayloadLegs, mergePayload, mergePayloadLeg, mergeRefusalText, mergeVerdict, previewMerge, type ServerMergePreview } from "./mergeProposal";
import { he } from "@/i18n/he";

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

describe("R6B10: the guest's return is the arrival at their origin (the request's own return time)", () => {
  const pt = (leg: "out" | "return", position: number, place_id: string, kind: string, eta: string) => ({ leg, position, place_id, kind, eta, name: place_id });
  // host H -> D -> H: out 07:15-08:15 (Z 04:15-05:15), back 09:00-10:00 local (Z 06:00-07:00)
  const roundHost = {
    ...host,
    route: [pt("out", 0, "H", "origin", "2026-10-11T04:15:00.000Z"), pt("out", 1, "D", "destination", "2026-10-11T05:15:00.000Z"),
      pt("return", 0, "D", "origin", "2026-10-11T06:00:00.000Z"), pt("return", 1, "H", "destination", "2026-10-11T07:00:00.000Z")],
  } as unknown as BoardRide;
  it("a pickup guest (T, return only) shows its arrival back at T, not the time it leaves D", () => {
    const guest = request({ trip_shape: "one_way_from", origin_id: "T", destination_id: "D", depart_at: null, return_at: "2026-10-11T06:50:00.000Z" });
    const preview = previewMerge(roundHost, guest, "return", { hop, stopMinutes: 5, homeId: "H" })!;
    expect(preview.valid).toBe(true);
    // leaves D at 06:00Z, reaches T (45 min) before H: the joiner's return = the alight time at T, later than the board time
    expect(preview.joinerReturnAt).not.toBeNull();
    expect(Date.parse(preview.joinerReturnAt!)).toBeGreaterThan(Date.parse("2026-10-11T06:00:00.000Z"));
    expect(preview.boardEta).toBe(preview.joinerReturnAt);
  });
  it("R6B5: a one-way D -> H guest into the round trip is valid, boards on the return leg and asks for its own departure", () => {
    const guest = request({ trip_shape: "one_way_to", origin_id: "D", destination_id: "H", depart_at: "2026-10-11T06:00:00.000Z", return_at: null });
    const preview = previewMerge(roundHost, guest, "out", { hop, stopMinutes: 5, homeId: "H" })!;
    expect(preview.valid).toBe(true);
    expect(preview.swapped).toBe(true);
    expect(preview.joinerOutAt).toBe("2026-10-11T06:00:00.000Z");
    expect(preview.joinerReturnAt).toBeNull();
    expect(preview.timeChanges).toBe(false);
  });
});

describe("previewMerge", () => {
  it("leaves earlier by the added driving, keeps the end and reports the estimated stop time", () => {
    const preview = previewMerge(host, request({}), "out", { hop, stopMinutes: 5, homeId: "H" })!;
    expect(preview.startsAt).toBe("2026-10-11T04:00:00.000Z");
    expect(preview.endsAt).toBe(host.ends_at);
    // ETA shown on the 15-minute grid (R2B25): 04:20Z -> 04:15Z
    expect(preview.boardEta).toBe("2026-10-11T04:15:00.000Z");
    // R4B5: the joiner's own boarding time is the same value the popup and the text show
    expect(preview.joinerOutAt).toBe(preview.boardEta);
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
    const preview = previewMerge(host, request({ trip_shape: "one_way_from", origin_id: "H", destination_id: "T", destination_resolved_name: "Station", depart_at: null, return_at: "2026-10-11T04:15:00.000Z" }), "return", { hop, stopMinutes: 5, homeId: "H", detourLimitMinutes: 120 })!;
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

describe("server merge times (R5B5 / TODO U2)", () => {
  const raw = {
    ok: true, code: null, new_starts_at: "2026-10-11T04:00:00+00:00", new_ends_at: "2026-10-11T07:15:00+00:00",
    joiner_depart_at: "2026-10-11T04:00:00+00:00", joiner_return_at: null, joiner_old_depart_at: "2026-10-11T03:45:00+00:00",
  };
  it("parses merge_preview's jsonb into the fields the UI reads", () => {
    expect(parseServerMergePreview(raw)).toEqual({ ok: true, code: null, newStartsAt: raw.new_starts_at, newEndsAt: raw.new_ends_at, joinerDepartAt: raw.joiner_depart_at, joinerReturnAt: null, turnaroundSide: null, waivable: false });
    expect(parseServerMergePreview(null)).toBeNull();
    expect(parseServerMergePreview([1])).toBeNull();
    expect(parseServerMergePreview({ ok: false, code: "seats" })?.ok).toBe(false);
  });
  it("overrides the twin's window and the joiner's own times with the server's", () => {
    const guest = request({ trip_shape: "one_way_to" });
    const twin = previewMerge(host, guest, "out", { hop, stopMinutes: 0, homeId: "H" });
    expect(twin).not.toBeNull();
    const shown = applyServerMergeTimes(twin, parseServerMergePreview(raw), guest)!;
    expect(shown.startsAt).toBe(raw.new_starts_at);
    expect(shown.endsAt).toBe(raw.new_ends_at);
    expect(shown.joinerOutAt).toBe(raw.joiner_depart_at);
    expect(shown.joinerReturnAt).toBeNull();
    expect(shown.boardEta).toBe(raw.joiner_depart_at);
    expect(shown.timeChanges).toBe(false);   // requested 04:00 = the server's joiner time
  });
  it("leaves the twin untouched without a server answer or for an invalid merge", () => {
    const guest = request({ trip_shape: "one_way_to" });
    const twin = previewMerge(host, guest, "out", { hop, stopMinutes: 0, homeId: "H" });
    expect(applyServerMergeTimes(twin, null, guest)).toBe(twin);
    expect(applyServerMergeTimes(null, parseServerMergePreview(raw), guest)).toBeNull();
  });
  it("takes the server's times and verdict when the twin refused but the server allows", () => {
    const guest = request({ trip_shape: "one_way_to" });
    const twin = { ...previewMerge(host, guest, "out", { hop, stopMinutes: 0, homeId: "H" })!, valid: false, invalid: "detour_too_long" as const };
    const shown = applyServerMergeTimes(twin, parseServerMergePreview(raw), guest)!;
    expect(shown.valid).toBe(true);
    expect(shown.invalid).toBeNull();
    expect(shown.startsAt).toBe(raw.new_starts_at);
    expect(shown.boardEta).toBe(raw.joiner_depart_at);
    const refused = applyServerMergeTimes(twin, { ...parseServerMergePreview(raw)!, ok: false, code: "detour" }, guest);
    expect(refused).toBe(twin);
  });
});

describe("mergeVerdict / mergeRefusalText (REQ item 108 M1: the server decides)", () => {
  const server = (patch: Partial<ServerMergePreview>): ServerMergePreview => ({ ok: true, code: null, newStartsAt: null, newEndsAt: null, joinerDepartAt: null, joinerReturnAt: null, ...patch });

  it("maps every server code to its reason text, unknown codes to the generic one", () => {
    expect(mergeRefusalText("maintenance")).toBe(he.mergedRide.invalid.maintenance);
    expect(mergeRefusalText("window")).toBe(he.mergedRide.invalid.window);
    expect(mergeRefusalText("seats")).toBe(he.mergedRide.invalid.seats_full);
    expect(mergeRefusalText("detour")).toBe(he.mergedRide.invalid.detour_too_long);
    expect(mergeRefusalText("luggage")).toBe(he.mergedRide.invalid.luggage_needs_large_trunk);
    expect(mergeRefusalText("boards_at_end")).toBe(he.mergedRide.invalid.boards_at_end);
    expect(mergeRefusalText("private_car")).toBe(he.mergedRide.invalid.private_car);
    expect(mergeRefusalText("turnaround")).toBe(he.mergedRide.invalid.turnaround_conflict);
    // R6B3: a clash with the PREVIOUS ride is named as such
    expect(mergeRefusalText("turnaround", "previous")).toBe(he.mergedRide.invalid.turnaround_conflict_previous);
    expect(mergeRefusalText("turnaround", "next")).toBe(he.mergedRide.invalid.turnaround_conflict);
    expect(mergeRefusalText("already_on_ride")).toBe(he.mergedRide.invalid.already_on_ride);
    expect(mergeRefusalText("something_new")).toBe(he.mergedRide.invalid.unknown);
    expect(mergeRefusalText(null)).toBe(he.mergedRide.invalid.unknown);
  });

  it("is loading until every call answered; a refusal wins over a pending call", () => {
    expect(mergeVerdict([{ data: undefined, isError: false }], null)).toEqual({ status: "loading" });
    expect(mergeVerdict([{ data: server({}), isError: false }, { data: undefined, isError: false }], null)).toEqual({ status: "loading" });
    expect(mergeVerdict([{ data: undefined, isError: false }, { data: server({ ok: false, code: "seats" }), isError: false }], null))
      .toMatchObject({ status: "refused", code: "seats", source: "server", message: he.mergedRide.invalid.seats_full });
  });

  it("allows only when the server says ok - the twin's objection does not matter", () => {
    expect(mergeVerdict([{ data: server({}), isError: false }], "detour_too_long")).toEqual({ status: "ok" });
  });

  it("a luggage-only refusal is waivable: the verdict stays ok, marked waivable (REQ §13.111 a)", () => {
    expect(parseServerMergePreview({ ok: false, code: "luggage", waivable: true })?.waivable).toBe(true);
    const waivable = server({ ok: false, code: "luggage", waivable: true });
    expect(mergeVerdict([{ data: waivable, isError: false }], null)).toEqual({ status: "ok", waivable: true });
    // a real refusal on another call still wins over a waivable one
    expect(mergeVerdict([{ data: waivable, isError: false }, { data: server({ ok: false, code: "seats" }), isError: false }], null))
      .toMatchObject({ status: "refused", code: "seats" });
    // a refusal that is not waivable stays a refusal
    expect(mergeVerdict([{ data: server({ ok: false, code: "luggage" }), isError: false }], null)).toMatchObject({ status: "refused", code: "luggage" });
  });

  it("falls back to the twin when the preview call failed", () => {
    expect(mergeVerdict([{ data: undefined, isError: true }], null)).toEqual({ status: "ok" });
    expect(mergeVerdict([{ data: undefined, isError: true }], "boards_at_end"))
      .toMatchObject({ status: "refused", source: "twin", message: he.mergedRide.invalid.boards_at_end });
    expect(mergeVerdict([{ data: null, isError: false }], "detour_too_long")).toMatchObject({ status: "refused", source: "twin" });
  });
});
