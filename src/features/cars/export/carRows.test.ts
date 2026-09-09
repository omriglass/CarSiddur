import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { issueRows, tireFillRows, washRows } from "./carRows";

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
    is_unsafe: true,
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

describe("issueRows", () => {
  it("emits a header row plus one row per issue with Hebrew category/status labels", () => {
    const rows = issueRows([issue()]);
    expect(rows[0]).toEqual([
      he.carPage.exportColumnDate, he.carPage.exportColumnReporter, he.carPage.exportColumnCategory,
      he.carPage.exportColumnDescription, he.carPage.exportColumnStatus, he.carPage.exportColumnUnsafe,
    ]);
    expect(rows[1]?.[1]).toBe("דנה");
    expect(rows[1]?.[2]).toBe(he.carCare.category.warning_light);
    expect(rows[1]?.[4]).toBe(he.adminIssues.statusOpen);
    expect(rows[1]?.[5]).toBe(he.adminIssues.unsafe);
  });

  it("falls back to the profile id when the reporter's name is missing", () => {
    const rows = issueRows([issue({ reported_by_profile: null, reported_by: "profile-9" })]);
    expect(rows[1]?.[1]).toBe("profile-9");
  });
});

describe("tireFillRows", () => {
  it("only includes tire_fill events, with five tire-position columns", () => {
    const tires = { front_left: "ok", front_right: "low", rear_left: "ok", rear_right: "very_low", spare: "ok" };
    const rows = tireFillRows([careEvent({ kind: "wash" }), careEvent({ id: "care-2", kind: "tire_fill", tires, note: "צמיג רזרבי חדש" })]);
    expect(rows).toHaveLength(2); // header + one tire_fill row (wash excluded)
    expect(rows[1]?.slice(2, 7)).toEqual([
      he.carPage.exportTireStateOk, he.carPage.exportTireStateLow, he.carPage.exportTireStateOk, he.carPage.exportTireStateVeryLow, he.carPage.exportTireStateOk,
    ]);
    expect(rows[1]?.[7]).toBe("צמיג רזרבי חדש");
  });

  it("leaves tire cells blank for malformed jsonb rather than throwing", () => {
    const rows = tireFillRows([careEvent({ kind: "tire_fill", tires: { front_left: "flat" } })]);
    expect(rows[1]?.slice(2, 7)).toEqual([null, null, null, null, null]);
  });
});

describe("washRows", () => {
  it("only includes wash events, date and reporter only", () => {
    const rows = washRows([careEvent({ kind: "tire_fill" }), careEvent({ id: "wash-2", kind: "wash" })]);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[1]).toBe("יוסי");
  });
});
