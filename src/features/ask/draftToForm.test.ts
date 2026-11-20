import { describe, expect, it } from "vitest";

import { REQUEST_FORM_DEFAULTS, type RequestFormValues } from "@/features/requests/schema";

import { applyDraftEdit, draftToNewRequest, formDiff, sentSnapshot, toQuarter, weekStartOfDay } from "./draftToForm";
import type { AskDraft } from "./types";

const catalog = {
  destinations: [{ id: "d-haifa", name: "חיפה" }, { id: "d-bin", name: "בנימינה" }],
  people: { Noa: { id: "c-noa", kind: "child" as const }, Dana: { id: "p-dana", kind: "member" as const }, Yael: null },
};
const draft = (over: Partial<AskDraft>): AskDraft => ({
  intent: "new_request", target_ride: null, ride_choices: [], flags: [], people: [], remove_people: [], stops: [], needs: [], ...over,
});
const base: RequestFormValues = {
  ...REQUEST_FORM_DEFAULTS, departmentId: "dep", weekStart: "2026-11-22", day: "2026-11-23", dayIndex: 1, rideTypeId: "rt",
  destination: { presetId: "d-haifa", name: "חיפה" }, origin: { freeText: "" }, companions: ["p-x"], children: [], childSeats: 0,
};

describe("draftToNewRequest", () => {
  it("fills day, week, arrive-by time, place and trip type", () => {
    const { patch, weekStart } = draftToNewRequest(draft({ date: "2026-11-26", time: "09:50", time_mode: "arrive_by",
      destination: { text: "binyamina", list_name: "בנימינה" }, trip_type: "drop_off" }), catalog);
    expect(weekStart).toBe("2026-11-22");
    expect(patch).toMatchObject({ day: "2026-11-26", departAnchor: "arrive", arriveByTime: "09:45",
      destination: { presetId: "d-bin", name: "בנימינה" }, tripType: "drop_off", dropOffPickup: false, tripShape: "one_way_to" });
  });

  it("keeps an unlisted place as typed text and an unknown or ambiguous name out of the form", () => {
    const { patch, unresolved } = draftToNewRequest(draft({ destination: { text: "the clinic", list_name: null },
      people: ["Dana", "Noa", "Yael", "Avi"], needs: ["large_trunk"], time: "10:00", return_time: "13:10" }), catalog);
    expect(patch.destination).toEqual({ freeText: "the clinic" });
    expect(patch).toMatchObject({ companions: ["p-dana"], children: ["c-noa"], childSeats: 1, luggage: true,
      departAnchor: "leave", departTime: "10:00", returnTime: "13:15" });
    expect(unresolved).toEqual(["Yael", "Avi"]);
  });

  it("rounds to the 15-minute grid and finds the Sunday", () => {
    expect(toQuarter("23:55")).toBe("23:45");
    expect(toQuarter("09:59", "down")).toBe("09:45");
    expect(weekStartOfDay("2026-11-28")).toBe("2026-11-22");
    expect(weekStartOfDay("2026-11-22")).toBe("2026-11-22");
  });
});

describe("applyDraftEdit", () => {
  it("changes only what the draft changes", () => {
    const { values } = applyDraftEdit(base, draft({ intent: "edit_request", return_time: "13:00" }), catalog);
    expect(values).toEqual({ ...base, returnAnchor: "arrive", returnTime: "13:00" });
  });

  it("adds stops and people, removes people, switches the trip type", () => {
    const { values } = applyDraftEdit(base, draft({ intent: "edit_request", trip_type: "one_way",
      stops: [{ leg: "return", text: "supermarket", list_name: null }], people: ["Noa"], remove_people: ["Dana"] }),
      { ...catalog, people: { ...catalog.people, Dana: { id: "p-x", kind: "member" } } });
    expect(values).toMatchObject({ tripType: "one_way", tripShape: "one_way_to", returnStops: [{ freeText: "supermarket" }],
      companions: [], children: ["c-noa"], childSeats: 1 });
  });
});

describe("formDiff", () => {
  it("lists the fields the member changed in the form, and the snapshot never carries the note", () => {
    const understood = { day: "2026-11-23", departTime: "10:00" };
    const sent = { ...base, notes: "secret", departTime: "10:30" };
    expect(formDiff(understood, sent)).toEqual({ departTime: { from: "10:00", to: "10:30" } });
    expect(sentSnapshot(sent)).not.toHaveProperty("notes");
  });
});
