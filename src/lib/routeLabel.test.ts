import { describe, expect, it } from "vitest";

import { tv } from "@/i18n/he";
import { routeLabel } from "./routeLabel";

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
