import { describe, expect, it } from "vitest";

import { NOTIFICATION_EVENTS } from "@/lib/enums";
import { inboxTabOf, mutableEventsByCategory, NOTIFICATION_EVENT_META } from "@/lib/notificationEvents";

/**
 * docs/TODO.md "Code review 2026-09-24" R2/R3/R6: one metadata source per notification
 * event, mirrored from `supabase/migrations/20260924110200_notification_event_meta.sql`.
 */
describe("NOTIFICATION_EVENT_META", () => {
  it("has a row for every canonical notification_event value", () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(NOTIFICATION_EVENT_META[event]).toBeDefined();
    }
  });

  it("every memberMutable event appears in exactly one mute-category bucket (R2)", () => {
    const byCategory = mutableEventsByCategory();
    const seen = new Map<string, string>();
    for (const [category, events] of Object.entries(byCategory)) {
      for (const event of events ?? []) {
        expect(seen.has(event)).toBe(false);
        seen.set(event, category);
      }
    }
    const mutableEvents = NOTIFICATION_EVENTS.filter((e) => NOTIFICATION_EVENT_META[e].memberMutable);
    expect(new Set(seen.keys())).toEqual(new Set(mutableEvents));
  });

  it("R2: waitlist_contested and waitlist_resolved are mutable, in the freedSlot category", () => {
    expect(NOTIFICATION_EVENT_META.waitlist_contested).toMatchObject({ category: "freedSlot", memberMutable: true });
    expect(NOTIFICATION_EVENT_META.waitlist_resolved).toMatchObject({ category: "freedSlot", memberMutable: true });
  });

  it("R3: window_changed lands on the siddur inbox tab", () => {
    expect(inboxTabOf("window_changed")).toBe("siddur");
  });

  it("R3: waitlist_contested and waitlist_resolved land on the freedSlot inbox tab", () => {
    expect(inboxTabOf("waitlist_contested")).toBe("freedSlot");
    expect(inboxTabOf("waitlist_resolved")).toBe("freedSlot");
  });

  it("car_swapped (S1) has a tab home (siddur, same as its mute category)", () => {
    expect(inboxTabOf("car_swapped")).toBe("siddur");
  });

  it("maps every event to exactly one inbox tab", () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(["proposals", "siddur", "freedSlot", "system"]).toContain(inboxTabOf(event));
    }
  });
});
