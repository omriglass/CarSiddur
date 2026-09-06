import { describe, expect, it } from "vitest";

import { computeDiffSummary, type DiffRequestRow, type DiffRideRow } from "./diffSummary";

function ride(id: string, patch: Partial<DiffRideRow> = {}): DiffRideRow {
  return { id, starts_at: "2026-09-15T08:00:00Z", ends_at: "2026-09-15T09:00:00Z", car_id: "car-1", status: "confirmed", ...patch };
}

function request(id: string, patch: Partial<DiffRequestRow> = {}): DiffRequestRow {
  return { id, status: "assigned", status_reason: null, ...patch };
}

describe("computeDiffSummary", () => {
  it("treats a first publish as all-new, everyone notified", () => {
    const result = computeDiffSummary({
      previousRides: null,
      currentRides: [ride("r1"), ride("r2", { status: "cancelled" })],
      previousRequests: null,
      currentRequests: [request("q1"), request("q2")],
    });
    expect(result.isFirstPublish).toBe(true);
    expect(result.newRides).toBe(1);
    expect(result.notifiedCount).toBe(2);
    expect(result.unnotifiedCount).toBe(0);
  });

  it("counts a ride present only in the current snapshot as new", () => {
    const result = computeDiffSummary({
      previousRides: [ride("r1")],
      currentRides: [ride("r1"), ride("r2")],
      previousRequests: [],
      currentRequests: [],
    });
    expect(result.newRides).toBe(1);
    expect(result.changedTimeRides).toBe(0);
    expect(result.cancelledRides).toBe(0);
  });

  it("counts a ride whose car or time changed", () => {
    const result = computeDiffSummary({
      previousRides: [ride("r1", { starts_at: "2026-09-15T08:00:00Z" })],
      currentRides: [ride("r1", { starts_at: "2026-09-15T08:30:00Z" })],
      previousRequests: [],
      currentRequests: [],
    });
    expect(result.changedTimeRides).toBe(1);
    expect(result.newRides).toBe(0);
  });

  it("counts a ride flipped to cancelled, and a ride removed outright, as cancelled", () => {
    const result = computeDiffSummary({
      previousRides: [ride("r1"), ride("r2")],
      currentRides: [ride("r1", { status: "cancelled" })],
      previousRequests: [],
      currentRequests: [],
    });
    expect(result.cancelledRides).toBe(2);
  });

  it("never double-counts an already-cancelled ride still present", () => {
    const result = computeDiffSummary({
      previousRides: [ride("r1", { status: "cancelled" })],
      currentRides: [ride("r1", { status: "cancelled" })],
      previousRequests: [],
      currentRequests: [],
    });
    expect(result.cancelledRides).toBe(0);
  });

  it("notifies only requests whose status changed since the last publish", () => {
    const result = computeDiffSummary({
      previousRides: [],
      currentRides: [],
      previousRequests: [request("q1", { status: "waitlisted" }), request("q2", { status: "assigned" })],
      currentRequests: [request("q1", { status: "assigned" }), request("q2", { status: "assigned" })],
    });
    expect(result.notifiedCount).toBe(1);
    expect(result.unnotifiedCount).toBe(1);
  });

  it("notifies a brand-new request (not present in the previous version)", () => {
    const result = computeDiffSummary({
      previousRides: [],
      currentRides: [],
      previousRequests: [],
      currentRequests: [request("q1")],
    });
    expect(result.notifiedCount).toBe(1);
  });
});
