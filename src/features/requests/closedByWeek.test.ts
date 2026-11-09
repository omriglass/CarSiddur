import { describe, expect, it } from "vitest";

import { closedByWeek, weekGroupKey } from "./closedByWeek";

import type { ClosedRequestRow } from "./api";

const row = (id: string, weekStart: string, departAt: string): ClosedRequestRow => ({
  id, departmentId: "d", weekStart, status: "withdrawn", statusReason: "WITHDRAWN_BY_MEMBER", departAt, returnAt: null,
  destination: "x", requesterName: null, updatedAt: departAt,
});

describe("closedByWeek (REQ §13.204 d)", () => {
  it("groups by week in week order and by day within a week", () => {
    const groups = closedByWeek([row("c", "2026-11-15", "2026-11-16T05:00:00Z"), row("b", "2026-11-08", "2026-11-11T05:00:00Z"), row("a", "2026-11-08", "2026-11-09T05:00:00Z")]);
    expect([...groups.keys()]).toEqual([weekGroupKey("2026-11-08", "d"), weekGroupKey("2026-11-15", "d")]);
    expect(groups.get(weekGroupKey("2026-11-08", "d"))?.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
