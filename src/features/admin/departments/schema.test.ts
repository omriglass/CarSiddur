import { describe, expect, it } from "vitest";

import { departmentSettingsSchema } from "./schema";

const VALID = {
  open_dow: 0, open_time: "00:00", close_dow: 3, close_time: "12:00", publish_dow: 3, publish_time: "20:00",
  turnaround_minutes: 30, day_end_time: "23:59", chauffeur_dwell_minutes: 10, detour_limit_minutes: 20, detour_limit_km: 15,
  closing_reminder_hours: [24, 2], auto_apply_accepted_proposals: true, board_start_time: "06:00", join_radius_km: 10, stop_minutes: 5,
  rush_morning_start: "07:00", rush_morning_end: "09:30", rush_morning_percent: 30,
  rush_afternoon_start: "15:30", rush_afternoon_end: "18:30", rush_afternoon_percent: 20,
};

describe("departmentSettingsSchema rush hours (REQ §13.113)", () => {
  it("accepts the defaults, with or without seconds", () => {
    expect(departmentSettingsSchema.safeParse(VALID).success).toBe(true);
    expect(departmentSettingsSchema.safeParse({ ...VALID, rush_morning_start: "07:00:00", rush_morning_end: "09:30:00" }).success).toBe(true);
  });

  it("refuses a window that ends before it starts, naming the end field", () => {
    const result = departmentSettingsSchema.safeParse({ ...VALID, rush_morning_start: "10:00" });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues.map((i) => i.path.join("."))).toContain("rush_morning_end");
  });

  it("refuses overlapping windows and percentages outside 0-100", () => {
    expect(departmentSettingsSchema.safeParse({ ...VALID, rush_afternoon_start: "09:00" }).success).toBe(false);
    expect(departmentSettingsSchema.safeParse({ ...VALID, rush_morning_percent: 101 }).success).toBe(false);
    expect(departmentSettingsSchema.safeParse({ ...VALID, rush_afternoon_percent: -1 }).success).toBe(false);
    expect(departmentSettingsSchema.safeParse({ ...VALID, rush_afternoon_percent: 0 }).success).toBe(true);
  });
});
