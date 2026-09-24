import { describe, expect, it } from "vitest";

import { MUTE_CATEGORIES } from "@/features/inbox/muteCategories";

/** docs/TODO.md "Code review 2026-09-24" R2: waiting-list events must be mutable. */
describe("MUTE_CATEGORIES", () => {
  it("R2: freedSlots category includes waitlist_contested and waitlist_resolved", () => {
    const freedSlots = MUTE_CATEGORIES.find((c) => c.key === "freedSlots");
    expect(freedSlots?.events).toEqual(
      expect.arrayContaining(["waitlist_contested", "waitlist_resolved"]),
    );
  });

  it("every category has a non-empty label and at least one event", () => {
    for (const category of MUTE_CATEGORIES) {
      expect(category.label).toBeTruthy();
      expect(category.events.length).toBeGreaterThan(0);
    }
  });

  it("no event appears in more than one mute category", () => {
    const seen = new Set<string>();
    for (const category of MUTE_CATEGORIES) {
      for (const event of category.events) {
        expect(seen.has(event)).toBe(false);
        seen.add(event);
      }
    }
  });
});
