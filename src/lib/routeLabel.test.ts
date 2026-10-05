import { describe, expect, it } from "vitest";

import { tv } from "@/i18n/he";
import { routeLabel, viaLabel } from "./routeLabel";
import { routeViaNames } from "./rideRoute";

describe("routeLabel (REQ §13.93)", () => {
  it("names only the destination when the origin is the department home", () => {
    expect(routeLabel({ destination: "Haifa", origin: "Home", originIsHome: true })).toBe(tv("route.to", { destination: "Haifa" }));
  });
  it("names the origin when it is not home", () => {
    expect(routeLabel({ destination: "Nahariya", origin: "Haifa", originIsHome: false }))
      .toBe(tv("route.fromTo", { origin: "Haifa", destination: "Nahariya" }));
  });
  it("treats an empty origin like home", () => {
    expect(routeLabel({ destination: "Haifa", origin: " ", originIsHome: false })).toBe(tv("route.to", { destination: "Haifa" }));
  });
  it("lists out-stops in order, with or without the origin", () => {
    expect(routeLabel({ destination: "Home", origin: "Haifa", originIsHome: false, stops: ["Binyamina", "Hadera"] }))
      .toBe(tv("route.via", { origin: "Haifa", destination: "Home", stops: "Binyamina, Hadera" }));
    expect(routeLabel({ destination: "Haifa", origin: "Home", originIsHome: true, stops: ["Binyamina"] }))
      .toBe(tv("route.toVia", { destination: "Haifa", stops: "Binyamina" }));
  });
});

describe("viaLabel / routeViaNames — the stops by name, not a count (owner 2026-10-05)", () => {
  it("lists a ride's intermediate places per leg, skipping start and destination", () => {
    const via = routeViaNames([
      { leg: "out", kind: "origin", name: "Home" },
      { leg: "out", kind: "stop", name: "Petah Tikva" },
      { leg: "out", kind: "board", name: "Tel Aviv" },
      { leg: "out", kind: "destination", name: "Haifa" },
      { leg: "return", kind: "origin", name: "Haifa" },
      { leg: "return", kind: "alight", name: "Hadera" },
      { leg: "return", kind: "destination", name: "Home" },
    ]);
    expect(via).toEqual({ out: ["Petah Tikva", "Tel Aviv"], return: ["Hadera"] });
    expect(viaLabel(via)).toBe(`${tv("route.viaStops", { stops: "Petah Tikva, Tel Aviv" })} · ${tv("route.viaStopsReturn", { stops: "Hadera" })}`);
  });
  it("is empty when the ride passes no stops", () => {
    expect(viaLabel(routeViaNames([{ leg: "out", kind: "origin", name: "Home" }, { leg: "out", kind: "destination", name: "Haifa" }]))).toBe("");
  });
});
