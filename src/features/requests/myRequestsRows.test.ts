import { describe, expect, it } from "vitest";

import { he, tv } from "@/i18n/he";
import type { MyRequestRow } from "./api";
import { confirmDialogDescription, confirmDialogLabel, confirmDialogTitle, displayStatus, ridePartOthers, seriesDayChoices, legStateLine, originDestinationLabel, ownLegWindow, requestStart, seriesSpanLine, toDisplayRows } from "./myRequestsRows";

function request(overrides: Partial<MyRequestRow> = {}): MyRequestRow {
  return {
    id: "request-1", departmentId: "dept-1", weekStart: "2026-09-13", status: "submitted",
    statusReason: null, isLate: false, changedSinceSolve: false, departAt: "2026-09-15T08:00:00+03:00",
    returnAt: "2026-09-15T12:00:00+03:00", tripShape: "round_trip", destination: "Destination",
    originId: null, originText: null, originName: null, stops: [], tripType: "round_trip",
    rideTypeId: "type-1", rideTypeName: "Type", rideTypeCode: null, needsCarAtDestination: true,
    version: 1, freedSlotOptOut: false, ride: null, pendingProposal: null, templateId: null,
    seriesId: null, seriesIndex: null, seriesCount: null,
    window: { phase: "open", open_at: "2026-09-01T00:00:00Z", close_at: "2026-09-12T23:00:00Z" },
    ...overrides,
  };
}

describe("requestStart", () => {
  it("prefers the assigned ride's start over the requested depart/return", () => {
    const row = request({
      departAt: "2026-09-14T08:00:00+03:00",
      ride: {
        id: "ride", startsAt: "2026-09-17T10:00:00+03:00", endsAt: "2026-09-17T15:00:00+03:00", status: "confirmed",
        originName: "Home", destinationName: "Home", carName: "Car", carType: "shared", driverName: "Driver", isChauffeur: false, role: "driver",
      },
    });
    expect(requestStart(row)).toBe(Date.parse("2026-09-17T10:00:00+03:00"));
  });

  it("falls back to returnAt for a one-way-from leg with no departAt", () => {
    const row = request({ departAt: null, returnAt: "2026-09-15T09:00:00+03:00", tripShape: "one_way_from" });
    expect(requestStart(row)).toBe(Date.parse("2026-09-15T09:00:00+03:00"));
  });
});

describe("toDisplayRows", () => {
  it("groups a multi-day request's legs into one card spanning the first depart to the last return", () => {
    const rows = [
      request({ id: "leg-1", seriesId: "series-1", seriesIndex: 1, seriesCount: 3, departAt: "2026-09-15T08:00:00+03:00", returnAt: "2026-09-15T23:59:00+03:00" }),
      request({ id: "leg-2", seriesId: "series-1", seriesIndex: 2, seriesCount: 3, departAt: "2026-09-16T00:00:00+03:00", returnAt: "2026-09-16T23:59:00+03:00" }),
      request({ id: "leg-3", seriesId: "series-1", seriesIndex: 3, seriesCount: 3, departAt: "2026-09-17T00:00:00+03:00", returnAt: "2026-09-17T12:00:00+03:00" }),
    ];
    const [display] = toDisplayRows(rows);
    expect(display!.id).toBe("leg-1");
    expect(display!.returnAt).toBe("2026-09-17T12:00:00+03:00");
    expect(display!.seriesLegs).toHaveLength(3);
  });

  it("R8B7: a series card shows a placement only when every day is published (an unpublished leg reads submitted)", () => {
    const [mixed] = toDisplayRows([
      request({ id: "a", seriesId: "s", seriesIndex: 1, status: "assigned", statusReason: "SERIES_PLACED" }),
      request({ id: "b", seriesId: "s", seriesIndex: 2, status: "submitted" }),
    ]);
    expect(mixed!.status).toBe("submitted");
    expect(mixed!.statusReason).toBeNull();
    const [all] = toDisplayRows([
      request({ id: "a", seriesId: "s2", seriesIndex: 1, status: "assigned" }),
      request({ id: "b", seriesId: "s2", seriesIndex: 2, status: "assigned" }),
    ]);
    expect(all!.status).toBe("assigned");
  });

  it("R13M4: an unplaced series card always says why", () => {
    const [noReason] = toDisplayRows([
      request({ id: "a", seriesId: "s", seriesIndex: 1, status: "waitlisted" }),
      request({ id: "b", seriesId: "s", seriesIndex: 2, status: "waitlisted" }),
    ]);
    expect(noReason!.statusReason).toBe("WAITLISTED_SERIES_NO_CAR");
    const [laterDay] = toDisplayRows([
      request({ id: "a", seriesId: "s", seriesIndex: 1, status: "waitlisted" }),
      request({ id: "b", seriesId: "s", seriesIndex: 2, status: "waitlisted", statusReason: "SERIES_CAR_UNAVAILABLE" }),
    ]);
    expect(laterDay!.statusReason).toBe("SERIES_CAR_UNAVAILABLE");
  });

  it("R13M4: a series card names its whole span; a single day has none", () => {
    const [series] = toDisplayRows([
      request({ id: "a", seriesId: "s", seriesIndex: 1, departAt: "2026-09-16T08:00:00+03:00", returnAt: "2026-09-16T23:59:00+03:00" }),
      request({ id: "b", seriesId: "s", seriesIndex: 2, departAt: "2026-09-18T00:00:00+03:00", returnAt: "2026-09-18T17:00:00+03:00" }),
    ]);
    expect(seriesSpanLine(series!)).toBe(tv("request.seriesSpan", { from: "ד׳ 16.9 08:00", to: "ו׳ 18.9 17:00" }));
    expect(seriesSpanLine(toDisplayRows([request()])[0]!)).toBeNull();
  });

  it("leaves an ordinary single-day request as its own row with no seriesLegs", () => {
    const [display] = toDisplayRows([request({ id: "solo" })]);
    expect(display!.id).toBe("solo");
    expect(display!.seriesLegs).toBeUndefined();
  });
});

describe("originDestinationLabel (REQ §13.93 'Multi-stop rides')", () => {
  it("shows the bare destination for the mundane case (home origin, no stops)", () => {
    const row = request({ originId: "home-dest", originName: "נבו" });
    expect(originDestinationLabel(row, "home-dest")).toBe("Destination");
  });

  it("shows מ<origin> ל<destination> for a non-home origin with no stops", () => {
    const row = request({ originId: "haifa-dest", originName: "חיפה" });
    expect(originDestinationLabel(row, "home-dest")).toBe(tv("route.fromTo", { origin: "חיפה", destination: "Destination" }));
  });

  it("lists out-stop names even when the origin is home", () => {
    const row = request({
      originId: "home-dest",
      originName: "נבו",
      stops: [{ leg: "out", position: 1, placeId: "binyamina-dest", placeText: null, name: "בנימינה", eta: null, active: true }],
    });
    expect(originDestinationLabel(row, "home-dest")).toBe(tv("route.toVia", { destination: "Destination", stops: "בנימינה" }));
  });

  it("never lists return-stops in the one-line label", () => {
    const row = request({
      originId: "home-dest",
      originName: "נבו",
      stops: [{ leg: "return", position: 1, placeId: "binyamina-dest", placeText: null, name: "בנימינה", eta: null, active: true }],
    });
    expect(originDestinationLabel(row, "home-dest")).toBe("Destination");
  });
});

describe("confirmDialogDescription", () => {
  it("appends the series note only when the row spans multiple legs", () => {
    const solo = toDisplayRows([request()])[0]!;
    const series = toDisplayRows([
      request({ id: "leg-1", seriesId: "s", seriesIndex: 1 }),
      request({ id: "leg-2", seriesId: "s", seriesIndex: 2 }),
    ])[0]!;
    expect(confirmDialogDescription({ kind: "withdraw", row: solo })).toBe(he.request.withdrawConfirmBody);
    expect(confirmDialogDescription({ kind: "withdraw", row: series })).toBe(`${he.request.withdrawConfirmBody} ${he.request.seriesCancelBody}`);
  });

  it("returns the bulk-withdraw and freed-slot-claim copy for their own kinds", () => {
    expect(confirmDialogDescription({ kind: "withdrawAll", departmentId: "d", weekStart: "2026-09-13" })).toBe(he.requestsList.withdrawAllBody);
    expect(confirmDialogDescription({ kind: "withdrawFreedClaim", offerId: "o", requestId: "r" })).toBe(he.freedSlot.withdrawClaimBody);
  });
});

describe("per-leg state (R6B12, R7B8)", () => {
  const out = [{ leg: "out" as const, startsAt: "2026-09-15T08:00:00+03:00", endsAt: "2026-09-15T09:00:00+03:00" }];
  it("one placed leg of a two-leg request is waiting, with a per-leg line", () => {
    const row = request({ status: "assigned", legs: out });
    expect(displayStatus(row)).toBe("waitlisted");
    expect(legStateLine(row)).toBe(tv("request.legStateLine", { out: he.request.legPlaced, ret: he.request.legWaiting }));
  });
  it("both legs placed keeps assigned and shows no line", () => {
    const row = request({ status: "assigned", legs: [{ ...out[0]!, leg: "both" }] });
    expect(displayStatus(row)).toBe("assigned");
    expect(legStateLine(row)).toBeNull();
  });
  it("own times come from the rides carrying each leg (a merge moved the return)", () => {
    const legs = [...out, { leg: "return" as const, startsAt: "2026-09-15T21:00:00+03:00", endsAt: "2026-09-15T22:40:00+03:00" }];
    expect(ownLegWindow(request({ legs, ride: null }))).toEqual({ departAt: "2026-09-15T08:00:00+03:00", returnAt: "2026-09-15T22:40:00+03:00" });
  });
});

describe("a request served by its plan B (R10B5, R10U7)", () => {
  const alternative = {
    dropPlaceId: "p1", dropPlaceText: null, dropPlaceName: "Harish", arriveBy: "2026-09-15T05:00:00Z",
    pickup: true, pickupAt: "2026-09-15T16:00:00Z", pickupPlaceId: null as string | null, pickupPlaceText: null, pickupPlaceName: null, originalMain: null,
  };

  it("reads as placed even when the server status is waitlisted", () => {
    const [row] = toDisplayRows([request({ status: "waitlisted", servedByAlternative: true, alternative })]);
    expect(displayStatus(row!)).toBe("assigned");
    expect(displayStatus(toDisplayRows([request({ status: "waitlisted" })])[0]!)).toBe("waitlisted");
  });

  it("the remove dialog says it is placed, and names the pickup request only when there is one", () => {
    const same = toDisplayRows([request({ status: "assigned", servedByAlternative: true, alternative })])[0]!;
    const other = toDisplayRows([request({ status: "assigned", servedByAlternative: true, alternative: { ...alternative, pickupPlaceId: "p2" } })])[0]!;
    expect(confirmDialogDescription({ kind: "withdraw", row: same })).toBe(he.request.withdrawPlanBBody);
    expect(confirmDialogDescription({ kind: "cancel", row: other })).toBe(he.request.withdrawPlanBPickupBody);
    expect(confirmDialogDescription({ kind: "withdraw", row: toDisplayRows([request()])[0]! })).toBe(he.request.withdrawConfirmBody);
  });
});

describe("seriesDayChoices (R21U5)", () => {
  const ride = (id: string, startsAt: string) => ({
    id, version: 3, startsAt, endsAt: startsAt, status: "confirmed" as const, originName: "Home", destinationName: "Home",
    carName: "Car", carType: "shared" as const, driverName: "Driver", isChauffeur: false, role: "driver" as const,
  });
  const legs = [
    request({ id: "l1", seriesId: "s", seriesIndex: 1, seriesCount: 2, ride: ride("r1", "2026-09-15T08:00:00+03:00") }),
    request({ id: "l2", seriesId: "s", seriesIndex: 2, seriesCount: 2, ride: ride("r2", "2026-09-16T08:00:00+03:00") }),
  ];
  it("offers each day of a multi-day ride and words the main button as every day", () => {
    const row = { ...toDisplayRows([legs[0]!])[0]!, seriesLegs: legs };
    const action = { kind: "cancel" as const, row };
    expect(seriesDayChoices(action).map((leg) => leg.rideId)).toEqual(["r1", "r2"]);
    expect(confirmDialogTitle(action)).toBe(he.request.seriesCancelTitle);
    expect(confirmDialogLabel(action)).toBe(he.request.cancelAllDays);
  });
  it("a one-day ride, a withdrawal or a ride I only edit get no day choice", () => {
    const one = toDisplayRows([legs[0]!])[0]!;
    expect(seriesDayChoices({ kind: "cancel", row: one })).toEqual([]);
    expect(seriesDayChoices({ kind: "withdraw", row: { ...one, seriesLegs: legs } })).toEqual([]);
    expect(seriesDayChoices({ kind: "cancel", row: { ...one, seriesLegs: legs, editorOf: "someone" } as never })).toEqual([]);
  });
});

describe("ridePartOthers (R22B1)", () => {
  const ride = (id: string) => ({
    id, version: 3, startsAt: "2026-09-15T08:00:00+03:00", endsAt: "2026-09-15T16:00:00+03:00", status: "confirmed" as const,
    originName: "Home", destinationName: "Home", carName: "Car", carType: "shared" as const, driverName: "Me", isChauffeur: false, role: "driver" as const,
  });
  const work = request({ id: "work", ride: ride("chain") });
  const school = request({ id: "school", ride: ride("chain") });
  const other = request({ id: "other", ride: ride("elsewhere") });
  it("lists my other trips on the same ride", () => {
    expect(ridePartOthers({ kind: "cancel", row: school }, [work, school, other]).map((r) => r.id)).toEqual(["work"]);
  });
  it("nothing for a ride with only this trip, a cancelled partner, a withdrawal or a ride I only edit", () => {
    expect(ridePartOthers({ kind: "cancel", row: other }, [work, school, other])).toEqual([]);
    expect(ridePartOthers({ kind: "cancel", row: school }, [{ ...work, status: "cancelled" }, school])).toEqual([]);
    expect(ridePartOthers({ kind: "withdraw", row: school }, [work, school])).toEqual([]);
    expect(ridePartOthers({ kind: "cancel", row: { ...school, editorOf: "someone" } }, [work, school])).toEqual([]);
  });
});
