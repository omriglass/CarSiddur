import { describe, expect, it } from "vitest";

import { carHandoverLines, carHandoverNotes, combineSeriesNeighbours, mapCarNeighbours, type CarNeighbour, type CarNeighbours } from "./carHandover";

const VIEWER = "viewer";
function neighbour(overrides: Partial<CarNeighbour> = {}): CarNeighbour {
  return { rideId: "n", at: "2026-10-12T10:30:00+03:00", kind: "ride", name: "Dana", people: ["other"], gapMinutes: 30, tight: true, ...overrides };
}
const both = (next: CarNeighbour | null, prev: CarNeighbour | null): CarNeighbours => ({ next, prev });

describe("carHandoverNotes", () => {
  it("returns the next ride as returnBy and the previous as arrivesFrom when both are tight", () => {
    const next = neighbour({ rideId: "next" });
    const prev = neighbour({ rideId: "prev" });
    expect(carHandoverNotes(both(next, prev), VIEWER, [VIEWER])).toEqual({ returnBy: next, arrivesFrom: prev });
  });

  it("shows nothing unless the viewer drives or requested the ride", () => {
    expect(carHandoverNotes(both(neighbour(), null), VIEWER, ["someone-else"])).toEqual({});
    expect(carHandoverNotes(both(neighbour(), null), undefined, [VIEWER])).toEqual({});
  });

  it("ignores a gap that is not tight", () => {
    expect(carHandoverNotes(both(neighbour({ tight: false }), neighbour({ tight: false })), VIEWER, [VIEWER])).toEqual({});
  });

  it("hides the note when the viewer is also on the neighbouring ride (their own next ride)", () => {
    const notes = carHandoverNotes(both(neighbour({ people: ["other", VIEWER] }), neighbour({ people: ["x"] })), VIEWER, [VIEWER]);
    expect(notes.returnBy).toBeUndefined();
    expect(notes.arrivesFrom).toBeDefined();
  });

  it("returns nothing without neighbours", () => {
    expect(carHandoverNotes(undefined, VIEWER, [VIEWER])).toEqual({});
  });
});

describe("mapCarNeighbours / combineSeriesNeighbours", () => {
  it("maps the view row and falls back to kind 'ride' for unknown kinds", () => {
    const mapped = mapCarNeighbours({
      ride_id: "r", threshold_minutes: 30,
      next_ride_id: "n", next_starts_at: "2026-10-12T07:30:00Z", next_kind: "reservation", next_name: null, next_people: null, next_gap_minutes: 30, next_tight: true,
      prev_ride_id: null, prev_ends_at: null, prev_kind: null, prev_name: null, prev_people: null, prev_gap_minutes: null, prev_tight: false,
    });
    expect(mapped.next).toEqual({ rideId: "n", at: "2026-10-12T07:30:00Z", kind: "reservation", name: null, people: [], gapMinutes: 30, tight: true });
    expect(mapped.prev).toBeNull();
  });

  it("a series takes prev from its first leg and next from its last", () => {
    const first = both(neighbour({ rideId: "fn" }), neighbour({ rideId: "fp" }));
    const last = both(neighbour({ rideId: "ln" }), neighbour({ rideId: "lp" }));
    const combined = combineSeriesNeighbours(first, last);
    expect(combined?.prev?.rideId).toBe("fp");
    expect(combined?.next?.rideId).toBe("ln");
    expect(combineSeriesNeighbours(undefined, undefined)).toBeUndefined();
  });
});

describe("carHandoverLines", () => {
  const ride = { startsAt: "2026-10-12T08:00:00+03:00", endsAt: "2026-10-12T10:00:00+03:00" };

  it("names who takes the car next and when, with no day label on the same day", () => {
    const [line] = carHandoverLines({ returnBy: neighbour() }, ride);
    expect(line).toMatchObject({ id: "returnBy", day: "", time: "10:30" });
    expect(line!.before + line!.after).toContain("Dana");
    expect(line!.before + line!.after).not.toContain("{{");
  });

  it("uses the reservation and car-move wording, which carry no name", () => {
    const [res] = carHandoverLines({ returnBy: neighbour({ kind: "reservation", name: "X" }) }, ride);
    const [move] = carHandoverLines({ returnBy: neighbour({ kind: "car_move", name: "X" }) }, ride);
    expect(res!.before + res!.after).not.toContain("X");
    expect(move!.before + move!.after).not.toContain("X");
    expect(res!.before + res!.after).not.toBe(move!.before + move!.after);
  });

  it("adds the weekday + date when the neighbour is on another day", () => {
    const [line] = carHandoverLines({ returnBy: neighbour({ at: "2026-10-13T00:30:00+03:00" }) }, ride);
    expect(line!.day).not.toBe("");
    expect(line!.time).toBe("00:30");
  });

  it("the mirror note compares against this ride's start and names the previous ride's driver", () => {
    const [line] = carHandoverLines({ arrivesFrom: neighbour({ at: "2026-10-12T07:45:00+03:00", name: "Avi" }) }, ride);
    expect(line).toMatchObject({ id: "arrivesFrom", day: "", time: "07:45" });
    expect(line!.before + line!.after).toContain("Avi");
  });
});
