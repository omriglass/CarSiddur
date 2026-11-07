import { describe, expect, it } from "vitest";

import type { SendAllPreviewItem } from "../api";
import { groupByRecipient, isItemOn, skipsOf, toggleKeys } from "./sendAllPreview";

const item = (id: string, recipient: string, keys: string[]): SendAllPreviewItem =>
  ({ id, recipient_id: recipient, recipient_name: recipient.toUpperCase(), event: "outcome_changed", title: "t", body: "b", keys });

describe("send-all preview", () => {
  const a1 = item("1", "a", ["a:ride:r1"]);
  const a2 = item("2", "a", ["proposal:p1"]);
  const b1 = item("3", "b", ["proposal:p1"]);

  it("groups notices by recipient, keeping order", () => {
    expect(groupByRecipient([a1, b1, a2]).map((g) => [g.name, g.items.map((i) => i.id)])).toEqual([["A", ["1", "2"]], ["B", ["3"]]]);
  });

  it("unticking a proposal's notice for one party unticks it for every party", () => {
    const skipped = toggleKeys(new Set(), a2.keys, false);
    expect(isItemOn(b1, skipped)).toBe(false);
    expect(isItemOn(a1, skipped)).toBe(true);
    expect(isItemOn(b1, toggleKeys(skipped, b1.keys, true))).toBe(true);
  });

  it("splits skips into held-notice keys and proposal ids", () => {
    expect(skipsOf(new Set(["proposal:p1", "a:ride:r1"]))).toEqual({ keys: ["a:ride:r1"], proposals: ["p1"] });
  });
});
