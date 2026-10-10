import { describe, expect, it } from "vitest";

import { ridesNeedingWarning } from "./privateCar";

const rides = [
  { id: "a", driver_id: "u1" },
  { id: "b", driver_id: "u2" },
  { id: "c", driver_id: null },
];

describe("ridesNeedingWarning", () => {
  it("keeps rides driven by someone else or driverless", () => {
    expect(ridesNeedingWarning(rides, "u1").map((r) => r.id)).toEqual(["b", "c"]);
  });
  it("counts everything while no owner is chosen", () => {
    expect(ridesNeedingWarning(rides, null)).toHaveLength(3);
  });
  it("is empty with no rides", () => {
    expect(ridesNeedingWarning([], "u1")).toEqual([]);
  });
});
