import { describe, expect, it } from "vitest";

import { he, tv } from "@/i18n/he";

import type { ClosedRequestRow } from "./api";

import { closedReasonLine } from "./closedReasonLine";

const base: ClosedRequestRow = {
  id: "q1", departmentId: "d", weekStart: "2026-11-29", status: "withdrawn", statusReason: "WITHDRAWN_BY_MEMBER",
  departAt: "2026-11-30T06:15:00Z", returnAt: "2026-11-30T14:15:00Z", destination: "Binyamina", requesterName: null,
  updatedAt: "2026-11-26T16:47:36Z", closedByMe: false, closedByName: "Omri", closedAt: "2026-11-26T16:47:36Z",
};
const when = "⁦" + "18:47" + "⁩";

describe("closedReasonLine (DP1-7)", () => {
  it("a request someone else withdrew names them and when (production: the Sadran's join withdrew a member's request)", () => {
    expect(closedReasonLine(base).startsWith(tv("request.closedByOther", { name: "Omri" }))).toBe(true);
    expect(closedReasonLine(base)).toContain(when);
    expect(closedReasonLine(base)).toContain("26.11");
  });

  it("one I withdrew myself keeps the by-you wording, with when", () => {
    const line = closedReasonLine({ ...base, closedByMe: true });
    expect(line.startsWith(he.statusReason.WITHDRAWN_BY_MEMBER)).toBe(true);
    expect(line).toContain(when);
  });

  it("another reason keeps its own words; no history means no time", () => {
    const line = closedReasonLine({ ...base, status: "cancelled", statusReason: "CLOSED_BY_SADRAN", closedAt: null });
    expect(line).not.toContain("Omri");
    expect(line).not.toContain(" · ");
  });
});
