import { describe, expect, it } from "vitest";

import {
  anchorLabelKey,
  arriveByFromDeparture,
  departFromArriveBy,
  endEstimate,
  enteredOutTime,
  enteredReturnTime,
  resolveCarTimes,
  returnFromLeaveThere,
  switchOutAnchor,
  switchReturnAnchor,
} from "./timeAnchors";

describe("departFromArriveBy", () => {
  it("rounds the departure DOWN to 15 minutes", () => {
    expect(departFromArriveBy("09:30", 45)).toBe("08:45");
    expect(departFromArriveBy("09:30", 50)).toBe("08:30");
    expect(departFromArriveBy("09:30", 1)).toBe("09:15");
  });

  it("clamps to the start of the day", () => {
    expect(departFromArriveBy("00:15", 90)).toBe("00:00");
  });
});

describe("returnFromLeaveThere", () => {
  it("rounds the arrival home UP to 15 minutes", () => {
    expect(returnFromLeaveThere("13:00", 45)).toBe("13:45");
    expect(returnFromLeaveThere("13:00", 50)).toBe("14:00");
    expect(returnFromLeaveThere("13:00", 1)).toBe("13:15");
  });

  it("clamps to 23:59", () => {
    expect(returnFromLeaveThere("23:30", 60)).toBe("23:59");
  });
});

describe("resolveCarTimes", () => {
  const base = { departAnchor: "leave", returnAnchor: "arrive", departTime: "08:00", returnTime: "12:00" } as const;

  it("keeps the typed car times for the default anchors", () => {
    expect(resolveCarTimes(base, { outMinutes: 45, returnMinutes: 45 })).toEqual({ departTime: "08:00", returnTime: "12:00" });
  });

  it("derives the departure from arrive-by and the return from leave-there", () => {
    const anchored = { ...base, departAnchor: "arrive", arriveByTime: "09:30", returnAnchor: "leave", leaveDestTime: "13:00" } as const;
    expect(resolveCarTimes(anchored, { outMinutes: 45, returnMinutes: 50 })).toEqual({ departTime: "08:45", returnTime: "14:00" });
  });

  it("keeps the last derived car time while the route minutes are unknown", () => {
    const anchored = { ...base, departAnchor: "arrive", arriveByTime: "09:30", departTime: "08:45" } as const;
    expect(resolveCarTimes(anchored, { outMinutes: null, returnMinutes: null }).departTime).toBe("08:45");
  });
});

describe("endEstimate", () => {
  it("describes each of the four anchored ends", () => {
    expect(endEstimate("out", "arrive", "09:30", 45)).toEqual({ kind: "departEstimate", time: "08:45", minutes: 45 });
    expect(endEstimate("out", "leave", "08:00", 45)).toEqual({ kind: "arriveEstimate", time: "08:45", minutes: 45 });
    expect(endEstimate("return", "leave", "13:00", 45)).toEqual({ kind: "homeEstimate", time: "13:45", minutes: 45 });
    expect(endEstimate("return", "arrive", "14:00", 45)).toEqual({ kind: "leaveEstimate", time: "13:15", minutes: 45 });
  });
});

describe("anchorLabelKey", () => {
  it("picks the label for each end, a הקפצה pickup reads 'pickup leave'", () => {
    expect(anchorLabelKey("out", "leave", false)).toBe("outLeave");
    expect(anchorLabelKey("out", "arrive", false)).toBe("outArrive");
    expect(anchorLabelKey("return", "arrive", false)).toBe("returnArrive");
    expect(anchorLabelKey("return", "leave", false)).toBe("returnLeave");
    expect(anchorLabelKey("return", "leave", true)).toBe("pickupLeave");
    expect(anchorLabelKey("return", "arrive", true)).toBe("pickupArrive");
  });
});

describe("anchor switching keeps the typed time", () => {
  it("leave 08:00 -> arrive-by 08:00 and back", () => {
    const toArrive = switchOutAnchor({ departAnchor: "leave", departTime: "08:00" }, "arrive");
    expect(toArrive).toMatchObject({ departAnchor: "arrive", arriveByTime: "08:00" });
    expect(enteredOutTime(toArrive)).toBe("08:00");
    const back = switchOutAnchor({ ...toArrive, arriveByTime: "09:30", departTime: "08:45" }, "leave");
    expect(back).toMatchObject({ departAnchor: "leave", arriveByTime: undefined, departTime: "09:30" });
  });

  it("home-by 12:00 -> leave-there 12:00 and back", () => {
    const toLeave = switchReturnAnchor({ returnAnchor: "arrive", returnTime: "12:00" }, "leave");
    expect(toLeave).toMatchObject({ returnAnchor: "leave", leaveDestTime: "12:00" });
    expect(enteredReturnTime(toLeave)).toBe("12:00");
    expect(switchReturnAnchor({ ...toLeave, leaveDestTime: "13:00", returnTime: "13:45" }, "arrive")).toMatchObject({
      returnAnchor: "arrive",
      leaveDestTime: undefined,
      returnTime: "13:00",
    });
  });
});

describe("arriveByFromDeparture (plan B drop time)", () => {
  it("adds the route minutes and rounds up to the quarter hour", () => {
    expect(arriveByFromDeparture("09:00", 45)).toBe("09:45");
    expect(arriveByFromDeparture("09:00", 50)).toBe("10:00");
    expect(arriveByFromDeparture("09:15", 8)).toBe("09:30");
  });
  it("never passes 23:59", () => {
    expect(arriveByFromDeparture("23:30", 90)).toBe("23:59");
  });
  it("round-trips with departFromArriveBy on exact quarters", () => {
    expect(arriveByFromDeparture(departFromArriveBy("10:00", 45), 45)).toBe("10:00");
  });
});
