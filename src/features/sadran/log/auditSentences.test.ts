import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";
import type { AuditLogRow } from "../api";
import { requestHistory } from "./auditSentences";

const row = (id: number, table_name: string, row_id: string, extra: Partial<AuditLogRow> = {}): AuditLogRow => ({
  id, table_name, row_id, action: "update", actor_role: "sadran", at: `2040-01-01T10:0${id}:00Z`, after: null, before: null,
  changed_columns: [], department_id: "d", reason: null, subject_profile_id: null, week_start: "2040-01-01", actor_id: null, ...extra,
});

describe("requestHistory", () => {
  it("keeps only the request's own rows, its rides' and its proposals', oldest first, as sentences", () => {
    const lines = requestHistory([
      row(4, "proposals", "p1", { after: { status: "sent" }, changed_columns: ["status"] }),
      row(1, "requests", "q1", { action: "insert" }),
      row(2, "rides", "r1", { changed_columns: ["car_id"] }),
      row(3, "rides", "other"),
      row(5, "requests", "q2"),
    ], { requestId: "q1", rideIds: ["r1"], proposalIds: ["p1"] });
    expect(lines.map((line) => line.what)).toEqual([
      he.sadranLog.sentence.requestInsert,
      he.sadranLog.sentence.rideCar,
      he.sadranLog.sentence.proposalSent,
    ]);
    expect(lines[0]?.actor).toBe(he.sadranLog.actorSadran);
  });
});
