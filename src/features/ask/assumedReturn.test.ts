import { describe, expect, it } from "vitest";

import { withAssumedReturn } from "./assumedReturn";
import type { AskDraft } from "./types";

const draft = (over: Partial<AskDraft>): AskDraft => ({
  intent: "new_request", target_ride: null, ride_choices: [], flags: [], people: [], remove_people: [], stops: [], needs: [],
  date: "2026-11-23", time: "08:00", time_mode: "depart", destination: { text: "חיפה", list_name: "חיפה" }, ...over,
});
const travel = (name: string) => (name === "חיפה" ? 20 : null);

describe("withAssumedReturn", () => {
  it("a round trip with no return is back 3 hours after leaving", () => {
    expect(withAssumedReturn(draft({}), travel)).toMatchObject({ assumed: true, draft: { return_time: "11:00" } });
    // arrive by 10:00 with a 20-minute drive: leaves 09:40, back 12:40 → the next quarter
    expect(withAssumedReturn(draft({ time: "10:00", time_mode: "arrive_by" }), travel).draft.return_time).toBe("12:45");
  });

  it("shopping: the drive there, 1.5 hours, the drive back; unknown drive → 3 hours", () => {
    expect(withAssumedReturn(draft({ errand: "shopping" }), travel).draft.return_time).toBe("10:15");
    expect(withAssumedReturn(draft({ errand: "shopping", destination: { text: "באקה", list_name: null } }), travel).draft.return_time).toBe("11:00");
  });

  it("nothing when the return is said, the trip has no return, or the day/time/place is still missing", () => {
    for (const over of [{ return_time: "14:00" }, { trip_type: "one_way" as const }, { trip_type: "drop_off" as const }, { time: null }, { date: null }, { destination: null }]) {
      const result = withAssumedReturn(draft(over), travel);
      expect(result.assumed).toBe(false);
    }
    expect(withAssumedReturn(draft({ time: "22:30" }), travel).draft.return_time).toBe("23:45");
  });
});
