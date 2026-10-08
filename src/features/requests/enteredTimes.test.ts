import { describe, expect, it } from "vitest";

import { toInstant } from "./mapper";
import { enteredTimeLabels } from "./enteredTimes";

const DAY = "2026-10-13";

describe("enteredTimeLabels", () => {
  it("is empty for the default anchors (the car times are the entered ones)", () => {
    expect(enteredTimeLabels({ departAnchor: "leave", returnAnchor: "arrive", destinationName: "X" })).toEqual({ out: null, return: null });
    expect(enteredTimeLabels({ destinationName: "X" })).toEqual({ out: null, return: null });
  });

  it("labels an arrive-by outbound and a leave-there return", () => {
    const labels = enteredTimeLabels({
      departAnchor: "arrive",
      arriveBy: toInstant(DAY, "09:30", false),
      returnAnchor: "leave",
      leaveDestAt: toInstant(DAY, "13:00", false),
      destinationName: "Haifa",
    });
    expect(labels.out).toContain("09:30");
    expect(labels.return).toContain("Haifa");
    expect(labels.return).toContain("13:00");
  });

  it("uses the pickup wording for a הקפצה return and differs from the leave wording", () => {
    const base = { returnAnchor: "leave", leaveDestAt: toInstant(DAY, "13:00", false), destinationName: "Haifa" } as const;
    expect(enteredTimeLabels({ ...base, isPickup: true }).return).not.toBe(enteredTimeLabels(base).return);
  });

  it("ignores an anchor without its typed instant", () => {
    expect(enteredTimeLabels({ departAnchor: "arrive", arriveBy: null, destinationName: "X" }).out).toBeNull();
  });
});
