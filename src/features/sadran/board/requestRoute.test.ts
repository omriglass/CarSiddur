import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { requestRouteLine } from "./requestRoute";

describe("requestRouteLine", () => {
  it("omits a home origin but always names the trip type", () => {
    const line = requestRouteLine({ originId: "h", originName: "Home", destination: "Haifa", tripType: "one_way" }, "h");
    expect(line).not.toContain("Home");
    expect(line).toContain("Haifa");
    expect(line).toContain(he.request.tripTypeOneWay);
  });
  it("names a non-home or free-text origin", () => {
    expect(requestRouteLine({ originId: "x", originName: "Givat", destination: "Haifa", tripType: "drop_off" }, "h")).toContain("Givat");
    expect(requestRouteLine({ originText: "Somewhere", destination: "Haifa", tripType: "round_trip" }, "h")).toContain("Somewhere");
  });
});
