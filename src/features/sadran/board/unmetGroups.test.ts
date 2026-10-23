import { describe, expect, it } from "vitest";

import { areComplementaryLegs, groupComplementaryLegs } from "./unmetGroups";

import type { WeekRequestRow } from "../api";

const leg = (id: string, from: string, to: string, at: string, over: Partial<WeekRequestRow> = {}) => ({
  id, requester_id: "m1", trip_type: "one_way", trip_shape: "one_way_to", origin_id: from, destination_id: to,
  depart_at: at, return_at: null, ...over,
}) as unknown as WeekRequestRow;
const item = (request: WeekRequestRow) => ({ request });

describe("complementary one-way legs (R14M3)", () => {
  const out = leg("a", "home", "tlv", "2026-10-21T06:00:00.000Z");
  const back = leg("b", "tlv", "home", "2026-10-21T14:00:00.000Z");

  it("mirrored legs of one member on one day are complementary, the later one is the way back", () => {
    expect(areComplementaryLegs(out, back)).toBe(true);
    expect(areComplementaryLegs(back, out)).toBe(false);
  });

  it("a null origin means the department home", () => {
    expect(areComplementaryLegs(leg("a", null as unknown as string, "tlv", out.depart_at!), back, "home")).toBe(true);
  });

  it("other member, other places, other day or a round trip never pair", () => {
    expect(areComplementaryLegs(out, leg("b", "tlv", "home", back.depart_at!, { requester_id: "m2" }))).toBe(false);
    expect(areComplementaryLegs(out, leg("b", "tlv", "haifa", back.depart_at!))).toBe(false);
    expect(areComplementaryLegs(out, leg("b", "tlv", "home", "2026-10-22T14:00:00.000Z"))).toBe(false);
    expect(areComplementaryLegs(out, leg("b", "tlv", "home", back.depart_at!, { trip_type: "round_trip", trip_shape: "round_trip" }))).toBe(false);
  });

  it("groups the pair at the first card's place, keeps everything else and the order", () => {
    const other = leg("c", "home", "haifa", "2026-10-21T07:00:00.000Z", { requester_id: "m2" });
    const groups = groupComplementaryLegs([item(out), item(other), item(back)]);
    expect(groups.map((g) => g.items.map((i) => i.request.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("pairs even when the way back is listed first", () => {
    const groups = groupComplementaryLegs([item(back), item(out)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.request.id)).toEqual(["a", "b"]);
  });

  it("split drop-off legs are never grouped", () => {
    const groups = groupComplementaryLegs([{ request: out, leg: "out" as const }, item(back)]);
    expect(groups).toHaveLength(2);
  });
});
