import { describe, expect, it } from "vitest";

import type { RoutePoint } from "@/lib/rideRoute";

import { mergeRouteText } from "./mergeRouteText";
import { mergeAffectedRequestIds } from "./mergeAffected";

const at = (time: string) => `2026-12-01T${time}:00+02:00`;
const p = (position: number, placeId: string, kind: RoutePoint["kind"], requestId: string | null, time: string, leg: RoutePoint["leg"] = "out"): RoutePoint =>
  ({ leg, position, placeId, placeText: null, name: placeId, requestId, kind, eta: at(time) });

// The QA week's ride (R22B9): the driver's trip home -> Haifa via Zichron; Dana is dropped at Ein Shemer on the way.
const before = [
  p(0, "home", "origin", "host", "07:15"), p(1, "einshemer", "alight", "dana", "07:20"),
  p(2, "zichron", "stop", "host", "07:32"), p(3, "haifa", "destination", "host", "08:28"),
  p(0, "haifa", "origin", "host", "15:26", "return"), p(1, "home", "destination", "host", "16:30", "return"),
];
const trips = [{ requestId: "dana", leg: "out" as const, originId: "home", destinationId: "einshemer" }];
const window = { startsAt: at("07:15"), newStartsAt: at("07:15"), endsAt: at("16:30"), newEndsAt: at("16:30") };

describe("mergeAffectedRequestIds (R22B9 / R22U3)", () => {
  it("a joiner riding home -> Zichron (both already on the route) changes nobody's times", () => {
    expect(mergeAffectedRequestIds({ before, merged: before, ...window, trips })).toEqual(new Set());
  });

  it("a stop inserted before Ein Shemer moves Dana's drop-off: she is asked", () => {
    const merged = [
      before[0]!, p(1, "maanit", "alight", "joiner", "07:18"), { ...before[1]!, position: 2, eta: at("07:27") },
      ...before.slice(2),
    ];
    expect(mergeAffectedRequestIds({ before, merged, ...window, trips })).toEqual(new Set(["dana"]));
  });

  it("a stop after Ein Shemer leaves her out", () => {
    const merged = [...before.slice(0, 3), p(3, "binyamina", "alight", "joiner", "07:50"), { ...before[3]!, position: 4, eta: at("08:40") }, ...before.slice(4)];
    expect(mergeAffectedRequestIds({ before, merged, ...window, trips })).toEqual(new Set());
  });

  it("a trip boarding at the ride's start is affected when the start moves", () => {
    const rider = [{ requestId: "noa", leg: "out" as const, originId: "home", destinationId: "zichron" }];
    const earlier = [{ ...before[0]!, eta: at("07:00") }, ...before.slice(1)];
    expect(mergeAffectedRequestIds({ before, merged: earlier, ...window, newStartsAt: at("07:00"), trips: rider })).toEqual(new Set(["noa"]));
    expect(mergeAffectedRequestIds({ before, merged: before, ...window, trips: rider })).toEqual(new Set());
  });
});

describe("mergeRouteText (R22B9)", () => {
  it("names only the joiner's own places, a drop-off as a drop-off", () => {
    const route = [p(0, "home", "origin", "host", "07:15"), p(1, "Ein Shemer", "alight", "dana", "07:20"), p(2, "Zichron", "alight", "joiner", "07:32")];
    expect(mergeRouteText(route, "joiner", "Omer")).toBe("home ← Ein Shemer ← Zichron (משאירים את Omer)");
    expect(mergeRouteText([p(0, "home", "origin", "host", "07:15"), p(1, "Maanit", "board", "joiner", "07:20")], "joiner", "Omer")).toBe("home ← Maanit (איסוף Omer)");
  });
});
