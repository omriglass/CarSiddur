import { describe, expect, it } from "vitest";

import { duplicateChildRuns } from "./duplicateChildRuns";

import type { WeekRequestRow } from "../api";

const req = (over: Partial<WeekRequestRow>) => ({
  id: "r1", requester_id: "p1", status: "submitted", trip_shape: "round_trip",
  depart_at: "2026-10-12T07:00:00Z", return_at: "2026-10-12T09:00:00Z", destination_travel_minutes: 30,
  childNames: ["נועה"], ...over,
}) as WeekRequestRow;

describe("duplicateChildRuns", () => {
  it("flags the same child on two overlapping requests of different parents", () => {
    const runs = duplicateChildRuns([req({}), req({ id: "r2", requester_id: "p2", depart_at: "2026-10-12T07:30:00Z", return_at: "2026-10-12T09:30:00Z" })]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.requests.map((r) => r.id)).toEqual(["r1", "r2"]);
  });
  it("ignores the same parent, non-overlapping, different children and withdrawn requests", () => {
    expect(duplicateChildRuns([req({}), req({ id: "r2" })])).toEqual([]);
    expect(duplicateChildRuns([req({}), req({ id: "r2", requester_id: "p2", depart_at: "2026-10-12T10:00:00Z", return_at: "2026-10-12T11:00:00Z" })])).toEqual([]);
    expect(duplicateChildRuns([req({}), req({ id: "r2", requester_id: "p2", childNames: ["דן"] })])).toEqual([]);
    expect(duplicateChildRuns([req({}), req({ id: "r2", requester_id: "p2", status: "withdrawn" })])).toEqual([]);
  });
});
