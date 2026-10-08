import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import type { BoardRide } from "../api";
import { memberWeekExportSheets } from "./memberWeekWorkbook";

const departmentId = "department";
const weekStart = "2026-09-13";

describe("member week export sheets", () => {
  it("builds only the board sheet — no requests/scores sheets (Sadran-only data)", () => {
    const ride = { id: "ride", car_id: "car", driver_id: null, driver_name: null, department_id: departmentId, week_start: weekStart,
      status: "draft", notes: "Manual reservation", served: [], starts_at: "2026-09-14T06:00:00Z", ends_at: "2026-09-14T07:00:00Z" } as unknown as BoardRide;
    const sheets = memberWeekExportSheets({
      departmentId, weekStart, cars: [{ id: "car", name: "Shared car" }], rides: [ride],
    });
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe(he.excelExport.boardSheet);
    const flat = sheets[0]!.rows.flat().map((c) => (c && typeof c === "object" && "text" in c ? c.text : c));
    expect(flat).toContain("Shared car");
    expect(flat.some((t) => typeof t === "string" && t.startsWith("Manual reservation\n"))).toBe(true);
  });

  it("excludes rides outside the requested department/week and cancelled rides", () => {
    const ride = { id: "ride", car_id: "car", driver_id: null, driver_name: null, department_id: departmentId, week_start: weekStart,
      status: "draft", notes: "x", served: [], starts_at: "2026-09-14T06:00:00Z", ends_at: "2026-09-14T07:00:00Z" } as unknown as BoardRide;
    const sheets = memberWeekExportSheets({
      departmentId, weekStart, cars: [{ id: "car", name: "Shared car" }],
      rides: [ride, { ...ride, id: "cancelled", status: "cancelled" }, { ...ride, id: "other-dept", department_id: "elsewhere" }] as unknown as BoardRide[],
    });
    expect(sheets[0]!.rows.flat().filter((c) => c && typeof c === "object" && "text" in c && typeof c.text === "string" && c.text.startsWith("x\n"))).toHaveLength(1);
  });
});
