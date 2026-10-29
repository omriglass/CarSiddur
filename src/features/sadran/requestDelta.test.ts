import { describe, expect, it } from "vitest";

import type { BoardRide, WeekRequestRow } from "./api";
import { consentOf, requestDelta, requestDeltas, rideDeltaView } from "./requestDelta";

const at = (hhmm: string) => `2040-01-01T${hhmm}:00Z`;

function request(overrides: Partial<WeekRequestRow> = {}): WeekRequestRow {
  return {
    id: "q1", status: "assigned", trip_shape: "round_trip", trip_type: "round_trip", requester_full_name: "רותם",
    original_depart_at: at("08:00"), depart_at: at("08:00"), original_return_at: at("10:00"), return_at: at("10:00"),
    flex_depart_early: "00:15:00", flex_depart_late: "00:15:00", flex_return_early: "00:15:00", flex_return_late: "00:15:00",
    preferred_car_id: null, origin_resolved_name: "נבו", destination_resolved_name: "חיפה", companions: [], childNames: [], stops: [],
    ...overrides,
  } as unknown as WeekRequestRow;
}

function ride(overrides: Record<string, unknown> = {}, served: Record<string, unknown>[] = [{ request_id: "q1", role: "driver", leg: "both", car_mode: "keep", requester: "רותם" }]): BoardRide {
  return {
    id: "r1", status: "confirmed", car_id: "c1", starts_at: at("08:00"), ends_at: at("10:00"), driver_name: "רותם", is_chauffeur: false,
    served, route: [], people: [], ...overrides,
  } as unknown as BoardRide;
}

describe("requestDelta", () => {
  it("shows nothing for a move inside the flexibility, measured from the original time", () => {
    const delta = requestDelta(request({ depart_at: at("08:15") }), [ride({ starts_at: at("08:15"), ends_at: at("10:15") })]);
    expect(delta.depart?.shiftMinutes).toBe(15);
    expect(delta.beyondFlex).toBe(false);
  });

  it("flags a move beyond the flexibility even when the request row itself was shifted to match", () => {
    const moved = ride({ starts_at: at("08:30"), ends_at: at("10:30") });
    const delta = requestDelta(request({ depart_at: at("08:30"), return_at: at("10:30") }), [moved]);
    expect(delta.depart).toMatchObject({ asked: at("08:00"), got: at("08:30"), beyondFlex: true });
    expect(delta.return?.beyondFlex).toBe(true);
    expect(delta.beyondFlex).toBe(true);
    const view = rideDeltaView(moved, new Map([[delta.requestId, delta]]));
    expect(view?.hours).toEqual({ askedStart: at("08:00"), gotStart: at("08:30"), askedEnd: at("10:00"), gotEnd: at("10:30") });
  });

  it("falls back to depart_at/return_at when the originals are null, and 'day' flexibility never exceeds", () => {
    const delta = requestDelta(request({ original_depart_at: null, original_return_at: null, flex_depart_late: "1 day" }), [ride({ starts_at: at("11:00") })]);
    expect(delta.depart).toMatchObject({ asked: at("08:00"), beyondFlex: false });
  });

  it("judges a guest by its stop ETAs in the merged ride, not the ride's own start/end", () => {
    const route = [
      { leg: "out", position: 1, place_id: "p", name: "בנימינה", request_id: "q2", kind: "board", eta: at("08:10") },
      { leg: "out", position: 2, place_id: "d", name: "עפולה", request_id: "q2", kind: "alight", eta: at("09:00") },
      { leg: "return", position: 1, place_id: "d", name: "עפולה", request_id: "q2", kind: "alight", eta: at("11:05") },
    ];
    const guest = request({ id: "q2", requester_full_name: "נועה", original_depart_at: at("08:00"), original_return_at: at("11:00"), flex_depart_early: "00:00:00", flex_depart_late: "00:15:00", flex_return_late: "00:15:00" });
    const merged = ride({ starts_at: at("07:45"), ends_at: at("11:15"), driver_name: "יואב", route }, [
      { request_id: "q1", role: "driver", leg: "both", car_mode: "keep", requester: "יואב" },
      { request_id: "q2", role: "passenger", leg: "both", car_mode: "keep", requester: "נועה" },
    ]);
    const delta = requestDelta(guest, [merged]);
    expect(delta.depart).toMatchObject({ got: at("08:10"), viaStop: true, beyondFlex: false });
    expect(delta.return).toMatchObject({ got: at("11:05"), beyondFlex: false });
    expect(delta.ridesWith).toBe("יואב");
    expect(delta.beyondFlex).toBe(true);
  });

  it("judges a chauffeur pickup by the ride's end and a plain separate pickup by its start", () => {
    const pickup = request({ trip_type: "drop_off", return_at: at("12:00"), original_return_at: at("12:00") });
    const served = [{ request_id: "q1", role: "passenger", leg: "return", car_mode: "chauffeur", requester: "רותם" }];
    const chauffeur = requestDelta(pickup, [ride({ is_chauffeur: true, starts_at: at("11:00"), ends_at: at("12:00") }, served)]);
    expect(chauffeur.return).toMatchObject({ got: at("12:00"), beyondFlex: false });
    const plain = requestDelta(pickup, [ride({ starts_at: at("12:30"), ends_at: at("13:30") }, [{ ...served[0]!, car_mode: "keep" }])]);
    expect(plain.return).toMatchObject({ got: at("12:30"), beyondFlex: true });
  });

  it("lists people added to the ride and the request's people missing from it", () => {
    const people = [
      { key: "a", source: "driver", request_id: "q1", ride_passenger_id: null, person_id: "p1", child_id: null, display_name: "רותם", seat_kind: "adult", added_by: null, removable: false },
      { key: "b", source: "guest", request_id: "q2", ride_passenger_id: null, person_id: "p2", child_id: null, display_name: "נועה כהן", seat_kind: "adult", added_by: null, removable: true },
    ];
    const delta = requestDelta(request({ childNames: ["דני"] }), [ride({ people })]);
    expect(delta.peopleAdded).toEqual(["נועה כהן"]);
    expect(delta.peopleMissing).toEqual(["דני"]);
    expect(delta.beyondFlex).toBe(true);
  });

  it("reports a changed place from the ride's route, and an optional baseline overrides the request row", () => {
    const route = [
      { leg: "out", position: 0, name: "בנימינה", kind: "origin", eta: at("09:00") },
      { leg: "out", position: 1, name: "נתניה", kind: "destination", eta: at("10:00") },
    ];
    const r = request({ origin_resolved_name: "נבו", destination_resolved_name: "נתניה" });
    const delta = requestDelta(r, [ride({ route })]);
    expect(delta.places).toEqual([{ kind: "origin", asked: "נבו", got: "בנימינה", rideId: "r1" }]);
    expect(requestDelta(r, [ride({ route })], [], { requestedPlaces: { originName: "בנימינה" } }).places).toEqual([]);
  });

  it("records the preferred car as a log-only difference", () => {
    const delta = requestDelta(request({ preferred_car_id: "c9" }), [ride()]);
    expect(delta.car).toEqual({ askedCarId: "c9", gotCarId: "c1" });
    expect(delta.beyondFlex).toBe(false);
    expect(delta.anyDifference).toBe(true);
  });

  it("derives the consent state from the request's proposals", () => {
    const p = (status: string) => ({ request_id: "q1", status, updated_at: "" }) as never;
    expect(consentOf("q1", [])).toBe("none");
    expect(consentOf("q1", [p("draft")])).toBe("draft");
    expect(consentOf("q1", [p("accepted"), p("sent")])).toBe("sent");
    expect(consentOf("q1", [p("applied")])).toBe("agreed");
    expect(consentOf("q1", [p("declined"), p("withdrawn")])).toBe("none");
  });

  it("marks unplaced and denied requests and skips drafts and withdrawn ones", () => {
    const rows = [request({ id: "a", status: "denied" }), request({ id: "b", status: "submitted" }), request({ id: "c", status: "draft" }), request({ id: "d", status: "withdrawn" })];
    const deltas = requestDeltas(rows, []);
    expect([...deltas.keys()]).toEqual(["a", "b"]);
    expect(deltas.get("a")?.state).toBe("denied");
    expect(deltas.get("b")?.state).toBe("unplaced");
  });
});
