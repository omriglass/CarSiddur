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
import { rushWindowsForDay } from "./rushHours";

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
    expect(endEstimate("out", "arrive", "09:30", 45)).toEqual({ kind: "departEstimate", time: "08:45", minutes: 45, approx: false });
    expect(endEstimate("out", "leave", "08:00", 45)).toEqual({ kind: "arriveEstimate", time: "08:45", minutes: 45, approx: false });
    expect(endEstimate("return", "leave", "13:00", 45)).toEqual({ kind: "homeEstimate", time: "13:45", minutes: 45, approx: false });
    expect(endEstimate("return", "arrive", "14:00", 45)).toEqual({ kind: "leaveEstimate", time: "13:15", minutes: 45, approx: false });
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

// REQ §13.113: rush hours stretch only the two conversions (morning 07:00-09:30 +30 %, afternoon 15:30-18:30 +20 %).
describe("rush hours", () => {
  const sunday = rushWindowsForDay(
    { rush_morning_start: "07:00:00", rush_morning_end: "09:30:00", rush_morning_percent: 30, rush_afternoon_start: "15:30:00", rush_afternoon_end: "18:30:00", rush_afternoon_percent: 20 },
    "2026-10-11",
  );
  const friday = rushWindowsForDay(
    { rush_morning_start: "07:00:00", rush_morning_end: "09:30:00", rush_morning_percent: 30, rush_afternoon_start: "15:30:00", rush_afternoon_end: "18:30:00", rush_afternoon_percent: 20 },
    "2026-10-16",
  );

  it("arrive-by in the morning window: a 60-minute drive to 10:00 leaves earlier than the plain 09:00", () => {
    expect(departFromArriveBy("10:00", 60)).toBe("09:00");
    expect(departFromArriveBy("10:00", 60, sunday)).toBe("08:45"); // 69 clock minutes -> 08:51 -> down
    expect(endEstimate("out", "arrive", "10:00", 60, sunday)).toEqual({ kind: "departEstimate", time: "08:45", minutes: 69, approx: true });
  });

  it("no overlap (13:00 arrival) and Friday are the plain drive", () => {
    expect(departFromArriveBy("13:00", 60, sunday)).toBe("12:00");
    expect(departFromArriveBy("10:00", 60, friday)).toBe("09:00");
    expect(endEstimate("out", "arrive", "13:00", 60, sunday).approx).toBe(false);
    expect(endEstimate("out", "arrive", "10:00", 60, friday).approx).toBe(false);
  });

  it("a drive entirely in a window grows by exactly the percentage", () => {
    expect(departFromArriveBy("09:00", 60, sunday)).toBe("07:30"); // 78 min -> 07:42 -> down
    expect(endEstimate("out", "arrive", "09:00", 60, sunday).minutes).toBe(78);
  });

  it("leave-there in the afternoon window: the return home is later, rounded up", () => {
    expect(returnFromLeaveThere("16:00", 60)).toBe("17:00");
    expect(returnFromLeaveThere("16:00", 60, sunday)).toBe("17:15"); // 72 min -> 17:12 -> up
    expect(endEstimate("return", "leave", "16:00", 60, sunday)).toEqual({ kind: "homeEstimate", time: "17:15", minutes: 72, approx: true });
  });

  it("uses both windows: a morning drive and an afternoon drive on the same day", () => {
    const times = resolveCarTimes(
      { departAnchor: "arrive", arriveByTime: "09:00", returnAnchor: "leave", leaveDestTime: "16:00" },
      { outMinutes: 60, returnMinutes: 60 },
      sunday,
    );
    expect(times).toEqual({ departTime: "07:30", returnTime: "17:15" });
  });

  it("fixed times and the estimated-arrival lines are never stretched", () => {
    expect(resolveCarTimes({ departAnchor: "leave", departTime: "08:00", returnAnchor: "arrive", returnTime: "16:00" }, { outMinutes: 60, returnMinutes: 60 }, sunday)).toEqual({ departTime: "08:00", returnTime: "16:00" });
    expect(endEstimate("out", "leave", "08:00", 60, sunday)).toEqual({ kind: "arriveEstimate", time: "09:00", minutes: 60, approx: false });
    expect(endEstimate("return", "arrive", "16:00", 60, sunday)).toEqual({ kind: "leaveEstimate", time: "15:00", minutes: 60, approx: false });
  });

  it("clamps to the day bounds", () => {
    expect(departFromArriveBy("07:15", 120, sunday)).toBe("05:00"); // 11.5 base min inside the window, the rest plain: 05:11 -> down
    expect(departFromArriveBy("00:30", 120, sunday)).toBe("00:00");
    expect(returnFromLeaveThere("23:00", 120, sunday)).toBe("23:59");
    expect(returnFromLeaveThere("18:00", 600, sunday)).toBe("23:59");
  });

  it("plan B: 'leave at' -> arrive-by stretches the drive inside the window", () => {
    expect(arriveByFromDeparture("08:00", 60)).toBe("09:00");
    expect(arriveByFromDeparture("08:00", 60, sunday)).toBe("09:30"); // 78 min -> 09:18 -> up
    expect(arriveByFromDeparture("08:00", 60, friday)).toBe("09:00");
    expect(arriveByFromDeparture("23:30", 60, sunday)).toBe("23:59");
  });
});
