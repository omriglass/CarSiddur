import { describe, expect, it } from "vitest";

import { heldUpdateCount } from "./heldUpdates";

const row = (id: string, recipient: string, subject: string | null, day: string | null) =>
  ({ id, recipient_id: recipient, subject_kind: subject ? "ride" : "other", subject_id: subject, day });

describe("heldUpdateCount", () => {
  const held = [row("1", "a", "r1", "2026-10-20"), row("2", "a", "r1", "2026-10-20"), row("3", "b", "r1", "2026-10-20"),
    row("4", "a", "r2", "2026-10-21"), row("5", "a", null, null), row("6", "a", null, null)];
  it("counts one update per person and subject", () => {
    expect(heldUpdateCount(held)).toBe(5);
    expect(heldUpdateCount(held, "2026-10-20")).toBe(2);
    expect(heldUpdateCount(held, "2026-10-21")).toBe(1);
  });
  it("counts each week-level notice on its own", () => {
    expect(heldUpdateCount(held, null)).toBe(2);
  });
});
