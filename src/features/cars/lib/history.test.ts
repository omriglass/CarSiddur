import { describe, expect, it } from "vitest";

import { filterCarHistory, mergeCarHistory, parseTireStates } from "./history";

import type { CarCareEventWithReporter, CarIssueWithReporter } from "../api";

function issue(overrides: Partial<CarIssueWithReporter> = {}): CarIssueWithReporter {
  return {
    id: "issue-1",
    car_id: "car-1",
    department_id: "dept-1",
    reported_by: "profile-1",
    reported_by_profile: { full_name: "דנה" },
    description: "אור אזהרה נדלק",
    category: "warning_light",
    is_unsafe: false,
    photo_path: null,
    status: "open",
    resolved_by: null,
    resolved_at: null,
    created_at: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

function careEvent(overrides: Partial<CarCareEventWithReporter> = {}): CarCareEventWithReporter {
  return {
    id: "care-1",
    car_id: "car-1",
    department_id: "dept-1",
    kind: "wash",
    tires: null,
    note: null,
    reported_by: "profile-2",
    reported_by_profile: { full_name: "יוסי" },
    created_at: "2026-09-02T10:00:00Z",
    updated_at: "2026-09-02T10:00:00Z",
    ...overrides,
  };
}

describe("parseTireStates", () => {
  it("accepts a valid five-tire object", () => {
    const tires = { front_left: "ok", front_right: "low", rear_left: "ok", rear_right: "very_low", spare: "ok" };
    expect(parseTireStates(tires)).toEqual(tires);
  });

  it("rejects null, non-objects and missing/invalid keys", () => {
    expect(parseTireStates(null)).toBeNull();
    expect(parseTireStates("wash")).toBeNull();
    expect(parseTireStates({ front_left: "ok" })).toBeNull();
    expect(parseTireStates({ front_left: "flat", front_right: "ok", rear_left: "ok", rear_right: "ok", spare: "ok" })).toBeNull();
  });
});

describe("mergeCarHistory", () => {
  it("merges issues and care events into one date-descending list", () => {
    const merged = mergeCarHistory(
      [issue({ id: "issue-1", created_at: "2026-09-01T10:00:00Z" })],
      [careEvent({ id: "care-1", created_at: "2026-09-03T10:00:00Z" }), careEvent({ id: "care-2", created_at: "2026-09-02T10:00:00Z" })],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["care-1", "care-2", "issue-1"]);
    expect(merged[2]?.kind).toBe("issue");
    expect(merged[2]?.reporterName).toBe("דנה");
  });

  it("breaks same-timestamp ties by id, descending, for determinism", () => {
    const same = "2026-09-01T10:00:00Z";
    const merged = mergeCarHistory(
      [issue({ id: "a", created_at: same }), issue({ id: "c", created_at: same })],
      [careEvent({ id: "b", created_at: same })],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });

  it("parses tire fill jsonb into a typed tire-state record", () => {
    const tires = { front_left: "ok", front_right: "low", rear_left: "ok", rear_right: "very_low", spare: "ok" };
    const merged = mergeCarHistory([], [careEvent({ kind: "tire_fill", tires })]);
    expect(merged[0]?.tires).toEqual(tires);
  });
});

describe("filterCarHistory", () => {
  const entries = mergeCarHistory(
    [issue({ id: "issue-1", created_at: "2026-09-01T10:00:00Z" })],
    [
      careEvent({ id: "wash-1", kind: "wash", created_at: "2026-09-02T10:00:00Z" }),
      careEvent({ id: "tire-1", kind: "tire_fill", created_at: "2026-09-05T10:00:00Z" }),
    ],
  );

  it("'all' returns every entry unfiltered", () => {
    expect(filterCarHistory(entries, "all").map((entry) => entry.id)).toEqual(["tire-1", "wash-1", "issue-1"]);
  });

  it("filters by kind chip", () => {
    expect(filterCarHistory(entries, "issue").map((entry) => entry.id)).toEqual(["issue-1"]);
    expect(filterCarHistory(entries, "tire_fill").map((entry) => entry.id)).toEqual(["tire-1"]);
    expect(filterCarHistory(entries, "wash").map((entry) => entry.id)).toEqual(["wash-1"]);
  });

  it("filters by an inclusive Asia/Jerusalem date range", () => {
    expect(filterCarHistory(entries, "all", { from: "2026-09-02", to: "2026-09-02" }).map((entry) => entry.id)).toEqual(["wash-1"]);
    expect(filterCarHistory(entries, "all", { from: "2026-09-03" }).map((entry) => entry.id)).toEqual(["tire-1"]);
  });
});
