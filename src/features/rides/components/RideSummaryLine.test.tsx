import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RidePerson } from "../ridePeople";
import type { RideStretches } from "../rideStretches";

import { RideSummaryLine } from "./RideSummaryLine";

const stretches = vi.hoisted(() => ({ data: undefined as RideStretches | undefined, enabled: [] as boolean[] }));
vi.mock("../hooks", () => ({
  useRideStretchesQuery: (_id: string, _v: number, enabled: boolean) => { stretches.enabled.push(enabled); return { data: enabled ? stretches.data : undefined }; },
}));

const pt = (leg: "out" | "return", position: number, name: string, kind: string) => ({ leg, position, place_id: name, name, kind, eta: null });
const route = [pt("out", 0, "נבו", "origin"), pt("out", 1, "בנימינה", "destination"), pt("return", 0, "בנימינה", "destination"), pt("return", 1, "נבו", "origin")];
const person = (key: string, source: RidePerson["source"], name: string): RidePerson => ({
  key, source, request_id: source === "added" ? null : "q1", ride_passenger_id: null, person_id: null, child_id: null,
  display_name: name, seat_kind: "adult", added_by: null, removable: source !== "driver", leg: "both",
});
const people = [person("driver:d", "driver", "דנה"), person("added:a", "added", "ענבר"), person("added:n", "added", "נגה")];

describe("RideSummaryLine (RP1)", () => {
  it("a round trip without places in the middle says who rides which way", () => {
    stretches.data = {
      out: { spans: { "driver:d": [0, 1], "added:a": [0, 1] }, absent: [], free: [2] },
      return: { spans: { "driver:d": [0, 1], "added:n": [0, 1] }, absent: [], free: [2] },
    };
    render(<RideSummaryLine rideId="r1" version={1} route={route} people={people} lead="דנה לבנימינה" homeId="נבו" />);
    expect(screen.getByTestId("ride-summary")).toHaveTextContent("דנה וענבר לבנימינה. בחזור: דנה ונגה מבנימינה הביתה.");
  });

  it("onlyWhenMore: nothing when the sentence is just the label", () => {
    stretches.data = {
      out: { spans: { "driver:d": [0, 1] }, absent: [], free: [3] },
      return: { spans: { "driver:d": [0, 1] }, absent: [], free: [3] },
    };
    render(<RideSummaryLine rideId="r1" version={1} route={route} people={[people[0]!]} lead="דנה לבנימינה" onlyWhenMore />);
    expect(screen.queryByTestId("ride-summary")).toBeNull();
  });

  it("a one-way ride with nothing in the middle reads nothing", () => {
    stretches.enabled = [];
    render(<RideSummaryLine rideId="r1" version={1} route={route.slice(0, 2)} people={people} lead="דנה לבנימינה" />);
    expect(stretches.enabled).toEqual([false]);
    expect(screen.getByTestId("ride-summary")).toHaveTextContent("דנה לבנימינה");
  });
});
