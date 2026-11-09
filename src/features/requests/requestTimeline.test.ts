import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { requestTimeline } from "./requestTimeline";

import type { RequestHistoryEvent } from "./schema";

const ev = (kind: string, data: Record<string, unknown>, actor: string | null = "יאן גל"): RequestHistoryEvent => ({
  at: "2026-11-09T14:57:39Z", kind, actor, actor_role: actor ? "sadran" : null, data,
});

describe("requestTimeline (REQ §13.204)", () => {
  it("words filing, placement, ride changes and closing with the Sadran's reason", () => {
    const lines = requestTimeline([
      ev("filed", { depart: "2026-11-10T04:45:00Z", return: "2026-11-10T14:15:00Z", status: "submitted" }, "omri servi"),
      ev("placed", { car: "ריטה", starts: "2026-11-10T05:15:00Z", ends: "2026-11-10T13:30:00Z", leg: "both" }),
      ev("ride_car", { old_car: "ריטה", car: "חושי" }),
      ev("status", { status: "cancelled", status_reason: "CLOSED_BY_SADRAN", closed_reason: "got a lift" }),
    ]);
    expect(lines.map((line) => line.actor)).toEqual(["omri servi", "יאן גל", "יאן גל", "יאן גל"]);
    expect(lines[0]?.what).toContain("ג׳ 10.11");
    expect(lines[0]?.what).toContain("06:45–16:15");
    expect(lines[1]?.what).toContain("ריטה");
    expect(lines[1]?.what).toContain("07:15–15:30");
    expect(lines[2]?.what).toContain("חושי");
    expect(lines[3]?.what).toContain("got a lift");
  });

  it("gives a status its reason as a detail line, a notice its text, and the system as actor when nobody acted", () => {
    const [status, notice] = requestTimeline([
      ev("status", { status: "waitlisted", status_reason: "WAITLISTED_NO_CAR" }, null),
      ev("notice", { title: "שינוי בסידור שלך", body: "השיבוץ הוסר" }, null),
    ]);
    expect(status?.actor).toBe(he.requestHistory.system);
    expect(status?.what).toContain(he.status.waitlisted);
    expect(status?.detail).toBe(he.statusReason.WAITLISTED_NO_CAR);
    expect(notice?.actor).toBeNull();
    expect(notice?.detail).toBe("השיבוץ הוסר");
  });

  it("drops an event kind it does not know", () => {
    expect(requestTimeline([ev("something_new", {})])).toEqual([]);
  });
});
