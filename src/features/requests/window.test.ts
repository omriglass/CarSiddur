import { describe, expect, it } from "vitest";
import { canEditRequest, isRequestWindowOpen, type RequestWindow } from "./window";

const window: RequestWindow = {
  phase: "open",
  open_at: "2026-09-01T09:00:00+03:00",
  close_at: "2026-09-07T09:00:00+03:00",
};

describe("request editing window", () => {
  it("uses absolute instants, including the opening and closing boundaries", () => {
    expect(isRequestWindowOpen(window, Date.parse(window.open_at))).toBe(true);
    expect(isRequestWindowOpen(window, Date.parse("2026-09-07T06:00:00Z"))).toBe(true);
    expect(isRequestWindowOpen(window, Date.parse(window.open_at) - 1)).toBe(false);
    expect(isRequestWindowOpen(window, Date.parse(window.close_at) + 1)).toBe(false);
  });

  it("does not permit editing a public week despite a future deadline", () => {
    for (const phase of ["published", "live", "archived"] as const) {
      expect(isRequestWindowOpen({ ...window, phase }, Date.parse(window.open_at))).toBe(false);
    }
  });

  it("fails closed when the associated week is unavailable", () => {
    expect(isRequestWindowOpen(null)).toBe(false);
    expect(isRequestWindowOpen(undefined)).toBe(false);
  });
});


it("keeps assigned draft requests editable when the solver ran before the deadline", () => {
  const now = Date.parse(window.open_at);
  expect(canEditRequest({ status: "assigned", window: { ...window, phase: "solving" }, ride: { status: "draft" } }, now)).toBe(true);
  expect(canEditRequest({ status: "assigned", window, hasPublishedRide: true, ride: { status: "draft" } }, now)).toBe(false);
  expect(canEditRequest({ status: "assigned", window, ride: { status: "confirmed" } }, now)).toBe(false);
});

describe("canEditRequest on a published day (REQ §13.101 f)", () => {
  const published: RequestWindow = { ...window, phase: "published" };
  const now = Date.parse("2026-09-09T08:00:00Z");
  const base = { status: "assigned" as const, window: published, hasPublishedRide: true, departAt: "2026-09-10T06:00:00Z", returnAt: "2026-09-10T12:00:00Z" };

  it("allows a single-day request whose day has not passed", () => {
    expect(canEditRequest(base, now)).toBe(true);
  });
  it("refuses a series, a past day and a terminal status", () => {
    expect(canEditRequest({ ...base, seriesId: "s1" }, now)).toBe(false);
    expect(canEditRequest({ ...base, departAt: "2026-09-08T06:00:00Z", returnAt: "2026-09-08T09:00:00Z" }, now)).toBe(false);
    expect(canEditRequest({ ...base, status: "withdrawn" }, now)).toBe(false);
  });
});
