import { describe, expect, it } from "vitest";

import { buildDraftCard, rideChoices, rideLabel } from "./draftCard";
import type { AskDraft, AskRide } from "./types";

const draft = (over: Partial<AskDraft>): AskDraft => ({
  intent: "new_request", target_ride: null, ride_choices: [], flags: [], people: [], remove_people: [], stops: [], needs: [], ...over,
});
const rides: AskRide[] = [
  { ref: "RIDE_1", date: "2026-11-22", weekday: "Sunday", start: "08:00", end: "12:00", trip_type: "round_trip", origin: "נבו", destination: "חיפה", stops: [], people: [] },
  { ref: "RIDE_2", date: "2026-11-22", weekday: "Sunday", start: "16:00", end: "18:00", trip_type: "round_trip", origin: "נבו", destination: "בנימינה", stops: [], people: [] },
];

describe("buildDraftCard", () => {
  it("marks what is missing and asks the model's question", () => {
    const card = buildDraftCard(draft({ date: "2026-11-23", ask: "what_place" }), null, rides)!;
    expect(card.kind).toBe("new");
    expect(card.rows.find((r) => r.key === "where")?.value).toBeNull();
    expect(card.question).toBe("what_place");
    expect(card.complete).toBe(false);
  });

  it("asks when they come back once day, place and time are known, and highlights what the turn changed", () => {
    const first = draft({ date: "2026-11-23", destination: { text: "בנימינה", list_name: "בנימינה" }, time: "10:00", time_mode: "arrive_by" });
    const card = buildDraftCard(first, null, rides)!;
    expect(card.question).toBe("when_back");
    expect(card.rows.find((r) => r.key === "time")?.value).toBe("להגיע עד 10:00");
    const second = buildDraftCard({ ...first, return_time: "14:00" }, first, rides)!;
    expect(second.question).toBeNull();
    expect(second.complete).toBe(true);
    expect(second.rows.filter((r) => r.changed).map((r) => r.key)).toEqual(["back"]);
    expect(second.summary).toContain("בנימינה");
  });

  it("an edit shows the ride and the change as before → after", () => {
    const card = buildDraftCard(draft({ intent: "edit_request", target_ride: "RIDE_1", return_time: "13:00",
      stops: [{ leg: "return", text: "סופר", list_name: null }] }), null, rides)!;
    expect(card.kind).toBe("edit");
    expect(card.rows[0]?.value).toBe(rideLabel(rides[0]!));
    expect(card.rows.find((r) => r.key === "back")).toMatchObject({ value: "13:00", old: "12:00" });
    expect(card.rows.find((r) => r.key === "stops")?.value).toContain("לא ברשימה");
  });

  it("no card for a find / cancel / unclear answer, and the ride chips only when asked", () => {
    expect(buildDraftCard(draft({ intent: "unclear" }), null, rides)).toBeNull();
    const asking = draft({ intent: "edit_request", ask: "which_ride", ride_choices: ["RIDE_2", "RIDE_1"] });
    expect(buildDraftCard(asking, null, rides)).toBeNull();
    expect(rideChoices(asking, rides).map((r) => r.ref)).toEqual(["RIDE_2", "RIDE_1"]);
  });
});
