import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import type { BoardRide } from "../api";
import { memberWeekExportSheets } from "./memberWeekWorkbook";

const departmentId = "department";
const weekStart = "2026-09-13";

describe("member week export sheets", () => {
  it("builds only the board sheet — no requests/scores sheets (Sadran-only data)", () => {
    const ride = { id: "ride", car_id: "car", driver_id: null, driver_name: null, department_id: departmentId, week_start: weekStart,
      status: "draft", notes: "Manual reservation", served: [] } as unknown as BoardRide;
    const sheets = memberWeekExportSheets({
      departmentId, weekStart, cars: [{ id: "car", name: "Shared car" }], rides: [ride],
    });
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe(he.excelExport.boardSheet);
    expect(sheets[0]!.rows).toHaveLength(2);
    expect(sheets[0]!.rows[1]).toContain("Shared car");
    expect(sheets[0]!.rows[1]).toContain("Manual reservation");
  });

  it("excludes rides outside the requested department/week and cancelled rides", () => {
    const ride = { id: "ride", car_id: "car", driver_id: null, driver_name: null, department_id: departmentId, week_start: weekStart,
      status: "draft", notes: null, served: [] } as unknown as BoardRide;
    const sheets = memberWeekExportSheets({
      departmentId, weekStart, cars: [{ id: "car", name: "Shared car" }],
      rides: [ride, { ...ride, id: "cancelled", status: "cancelled" }, { ...ride, id: "other-dept", department_id: "elsewhere" }] as unknown as BoardRide[],
    });
    expect(sheets[0]!.rows).toHaveLength(2);
  });
});
