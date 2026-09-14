import { describe, expect, it } from "vitest";

import { buildRidePassengerInputs, splitReservationDriverAndPassengers } from "./reservationPeople";

describe("splitReservationDriverAndPassengers", () => {
  it("treats the first picked member as the driver (owner A5)", () => {
    expect(splitReservationDriverAndPassengers(["m1", "m2", "m3"])).toEqual({ driverId: "m1", passengerMemberIds: ["m2", "m3"] });
  });

  it("returns a null driver and no passengers when nobody was picked", () => {
    expect(splitReservationDriverAndPassengers([])).toEqual({ driverId: null, passengerMemberIds: [] });
  });

  it("has no passengers left when exactly one member (the driver) was picked", () => {
    expect(splitReservationDriverAndPassengers(["m1"])).toEqual({ driverId: "m1", passengerMemberIds: [] });
  });
});

describe("buildRidePassengerInputs", () => {
  const members = [{ id: "m1", name: "Alice" }, { id: "m2", name: "Bob" }];
  const children = [
    { id: "c1", name: "Kid Young", birthYear: 2023, age: 2, isAdultPassenger: false, isPriority: false },
    { id: "c2", name: "Kid Older", birthYear: 2010, age: 15, isAdultPassenger: true, isPriority: false },
  ];

  it("maps member ids to person_id adult rows with resolved display names", () => {
    expect(buildRidePassengerInputs(["m2"], [], members, children)).toEqual([
      { person_id: "m2", display_name: "Bob", seat_kind: "adult" },
    ]);
  });

  it("maps a young child to a child_seat row and an older child (isAdultPassenger) to an adult row", () => {
    expect(buildRidePassengerInputs([], ["c1", "c2"], members, children)).toEqual([
      { child_id: "c1", display_name: "Kid Young", seat_kind: "child_seat" },
      { child_id: "c2", display_name: "Kid Older", seat_kind: "adult" },
    ]);
  });

  it("falls back to an empty display name for an id no longer found in the candidate list", () => {
    expect(buildRidePassengerInputs(["missing"], [], members, children)).toEqual([
      { person_id: "missing", display_name: "", seat_kind: "adult" },
    ]);
  });

  it("combines members and children, members first", () => {
    expect(buildRidePassengerInputs(["m1"], ["c1"], members, children)).toEqual([
      { person_id: "m1", display_name: "Alice", seat_kind: "adult" },
      { child_id: "c1", display_name: "Kid Young", seat_kind: "child_seat" },
    ]);
  });
});
