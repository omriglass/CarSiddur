import { describe, expect, it } from "vitest";
import { he } from "@/i18n/he";
import type { WeekExportData } from "./api";
import { jerusalemExcelDate, weekExportSheets } from "./weekWorkbook";

const data: WeekExportData = {
  departmentId: "department", weekStart: "2026-09-13", cars: [{ id: "car", name: "Shared car" }], publication: null,
  requests: [], rides: [],
};

describe("weekly Excel export", () => {
  it("uses Jerusalem wall-clock dates across winter and summer offsets", () => {
    const epoch = Date.UTC(1899, 11, 30);
    expect(jerusalemExcelDate("2026-09-15T05:00:00Z")).toEqual({ excelDate: (Date.UTC(2026, 8, 15, 8) - epoch) / 86400000 });
    expect(jerusalemExcelDate("2026-01-15T06:00:00Z")).toEqual({ excelDate: (Date.UTC(2026, 0, 15, 8) - epoch) / 86400000 });
    expect(jerusalemExcelDate(null)).toBeNull();
  });

  it("exports unassigned requests, preferred cars, unstaffed reservations and notes in the chosen scope", () => {
    const request = { id: "request", requester_id: "member", requester_full_name: "Member", department_id: data.departmentId,
      week_start: data.weekStart, status: "waitlisted", trip_shape: "one_way_from", return_at: "2026-09-15T09:00:00Z",
      destination_resolved_name: "Destination", preferred_car_id: "car", notes: "=Literal note" };
    const ride = { id: "ride", car_id: "car", driver_id: null, driver_name: null, department_id: data.departmentId,
      week_start: data.weekStart, status: "draft", notes: "Manual reservation", served: [] };
    const sheets = weekExportSheets({ ...data,
      requests: [request, { ...request, id: "other-week", week_start: "2026-09-20" }] as WeekExportData["requests"],
      rides: [ride, { ...ride, id: "cancelled", status: "cancelled" }, { ...ride, id: "other-dept", department_id: "elsewhere" }] as unknown as WeekExportData["rides"],
    });
    expect(sheets[0]!.rows).toHaveLength(2);
    expect(sheets[0]!.rows[1]).toContain("Shared car");
    expect(sheets[0]!.rows[1]).toContain("=Literal note");
    expect(sheets[1]!.rows).toHaveLength(2);
    expect(sheets[1]!.rows[1]).toContain(he.excelExport.noDriver);
    expect(sheets[1]!.rows[1]).toContain("Manual reservation");
  });

  it("exports saved per-policy scores with their publication time, independently of current assignments", () => {
    const publication = { department_id: data.departmentId, week_start: data.weekStart, published_at: "2026-09-15T05:00:00Z",
      snapshot: { policy_scores: [{ policy_name: "Priority policy", policy_version_id: "version", profiles: [{ profile_id: "member", requests: [{ request_id: "request", score: 0.75, served: true, breakdown: [] }] }] }] } };
    const sheets = weekExportSheets({ ...data, publication: publication as unknown as WeekExportData["publication"] });
    expect(sheets[2]!.rows[1]).toEqual(["Priority policy", "version", "member", "request", 0.75, he.excelExport.yes, "[]", jerusalemExcelDate(publication.published_at)]);
  });
});
