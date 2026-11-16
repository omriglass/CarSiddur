import { describe, expect, it } from "vitest";

import { rideCoordinatorNoteFields, rideCoordinatorNotes } from "./rideCoordinatorNotes";

describe("rideCoordinatorNotes", () => {
  const requests = [
    { id: "q1", notes: " early ", requester_full_name: "Adi" },
    { id: "q2", notes: null, requester_full_name: "Ben" },
    { id: "q3", notes: "other ride", requester_full_name: "Gil" },
  ];
  it("lists the ride's own requests' notes, each after its requester's name (picked out)", () => {
    expect(rideCoordinatorNotes([{ request_id: "q1" }, { request_id: "q2" }], requests)).toBe("Adi: early");
    expect(rideCoordinatorNoteFields([{ request_id: "q1" }], requests).coordinatorNoteLines?.[0]?.[0]).toEqual({ text: "Adi:", emphasis: true });
    expect(rideCoordinatorNoteFields([{ request_id: "q2" }], requests)).toEqual({});
  });
});
