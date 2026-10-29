import { describe, expect, it } from "vitest";

import { closedReasonOf, isClosedBySadran } from "./changeLogRows";

const row = (id: number, at: string, reason: string | null, before: string | null, after: string, requestId = "q1") => ({
  id, at, reason, table_name: "requests", row_id: requestId,
  before: { status: before === null ? "waitlisted" : "cancelled", status_reason: before }, after: { status: "cancelled", status_reason: after },
});

describe("isClosedBySadran", () => {
  it("is true only for a request the Sadran closed", () => {
    expect(isClosedBySadran({ status: "cancelled", status_reason: "CLOSED_BY_SADRAN" })).toBe(true);
    expect(isClosedBySadran({ status: "cancelled", status_reason: "RIDE_CANCELLED" })).toBe(false);
    expect(isClosedBySadran({ status: "waitlisted", status_reason: "CLOSE_UNDONE" })).toBe(false);
  });
});

describe("closedReasonOf", () => {
  it("reads the reason of the latest closing row of that request", () => {
    const audit = [
      row(1, "2040-01-01T08:00:00Z", "first", null, "CLOSED_BY_SADRAN"),
      row(2, "2040-01-02T08:00:00Z", "second", "RIDE_CANCELLED", "CLOSED_BY_SADRAN"),
      row(3, "2040-01-03T08:00:00Z", "other", null, "CLOSED_BY_SADRAN", "q2"),
    ];
    expect(closedReasonOf(audit, "q1")).toBe("second");
  });

  it("is null when the Sadran gave no reason or there is no closing row", () => {
    expect(closedReasonOf([row(1, "2040-01-01T08:00:00Z", "close_request", null, "CLOSED_BY_SADRAN")], "q1")).toBeNull();
    expect(closedReasonOf([row(1, "2040-01-01T08:00:00Z", "x", null, "RIDE_CANCELLED")], "q1")).toBeNull();
    expect(closedReasonOf([], "q1")).toBeNull();
  });
});
