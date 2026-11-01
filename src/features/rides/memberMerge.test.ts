import { describe, expect, it } from "vitest";

import type { BoardRide, MemberMergePreview } from "./api";
import { memberMergeAgreeNames, memberMergeTarget, memberMergeWaitChoice } from "./memberMerge";

const person = (id: string, name: string, requestId: string, source = "requester") => ({
  key: `${source}:${id}`, source, request_id: requestId, ride_passenger_id: null, person_id: id, child_id: null,
  display_name: name, seat_kind: "adult", added_by: null, removable: true,
});

function ride(overrides: Partial<BoardRide> = {}): BoardRide {
  return {
    id: "pickup", status: "flagged", needs_driver: true, driver_id: null,
    served: [{ request_id: "qe", role: "passenger", leg: "return", car_mode: "chauffeur", adults: 1, child_seats: 0, boosters: 0, luggage: false, destination: "בנימינה" }],
    people: [person("eli", "אלי", "qe")],
    ...overrides,
  } as unknown as BoardRide;
}

const preview: MemberMergePreview = {
  ok: false, code: "detour", leg: "return", guestName: "אלי", longDetour: { outMinutes: 0, returnMinutes: 66, unknownHops: [] }, luggageProblem: false,
  joinerDepartAt: null, joinerReturnAt: "2026-11-03T12:27:00Z", wantedDepartAt: null, wantedReturnAt: "2026-11-03T13:30:00Z",
  waitStartsAt: null, waitEndsAt: "2026-11-03T13:45:00Z", timeKept: false, waitKeepsTime: true, direct: false, directWithWait: true,
  sourceDriverName: null, otherRiders: [],
};

describe("memberMergeTarget (REQ §13.175 d)", () => {
  it("is the rider of the one ride my move runs into", () => {
    expect(memberMergeTarget([ride()], "shai")).toMatchObject({ requestId: "qe", name: "אלי" });
  });
  it("is nobody for several rides, my own seat, a driver's own trip or a reservation", () => {
    expect(memberMergeTarget([ride(), ride({ id: "other" } as Partial<BoardRide>)], "shai")).toBeNull();
    expect(memberMergeTarget([ride()], "eli")).toBeNull();
    expect(memberMergeTarget([ride({ served: [{ request_id: "qd", role: "driver", leg: "both", car_mode: "keep" }], people: [person("dan", "דן", "qd", "driver")] } as unknown as Partial<BoardRide>)], "shai")).toBeNull();
    expect(memberMergeTarget([ride({ served: [], people: [] } as unknown as Partial<BoardRide>)], "shai")).toBeNull();
  });
});

describe("member merge questions (REQ §13.175 d)", () => {
  it("offers to stretch my ride to the guest's pickup time", () => {
    expect(memberMergeWaitChoice(preview)).toEqual({ side: "return", eta: preview.joinerReturnAt, wanted: preview.wantedReturnAt, startsAt: null, endsAt: preview.waitEndsAt });
    expect(memberMergeWaitChoice({ ...preview, waitKeepsTime: false })).toBeNull();
  });
  it("names whoever the change touches when it is not direct", () => {
    expect(memberMergeAgreeNames(preview, true)).toEqual([]);
    expect(memberMergeAgreeNames(preview, false)).toEqual(["אלי"]);
    expect(memberMergeAgreeNames({ ...preview, timeKept: true, sourceDriverName: "דן", otherRiders: ["רון"] }, false)).toEqual(["אלי", "דן", "רון"]);
  });
});
