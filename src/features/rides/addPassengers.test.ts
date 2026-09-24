import { describe, expect, it } from "vitest";

import { buildAddPassengerInputs } from "./addPassengers";

describe("buildAddPassengerInputs", () => {
  const members = [{ id: "m1", name: "Alice" }, { id: "m2", name: "Bob" }];
  const children = [
    { id: "c1", name: "Kid Young", birthYear: 2023, age: 2, isAdultPassenger: false, isPriority: false },
    { id: "c2", name: "Kid Older", birthYear: 2010, age: 15, isAdultPassenger: true, isPriority: false },
  ];

  it("maps member ids to person_id adult rows with resolved display names", () => {
    expect(buildAddPassengerInputs(["m2"], [], "", members, children)).toEqual([
      { person_id: "m2", display_name: "Bob", seat_kind: "adult" },
    ]);
  });

  it("maps a young child to a child_seat row and an older child (isAdultPassenger) to an adult row", () => {
    expect(buildAddPassengerInputs([], ["c1", "c2"], "", members, children)).toEqual([
      { child_id: "c1", display_name: "Kid Young", seat_kind: "child_seat" },
      { child_id: "c2", display_name: "Kid Older", seat_kind: "adult" },
    ]);
  });

  it("splits free-text guest names by line into adult rows, trimming and dropping blanks", () => {
    expect(buildAddPassengerInputs([], [], "  אורח ראשון \n\nאורח שני\n", members, children)).toEqual([
      { display_name: "אורח ראשון", seat_kind: "adult" },
      { display_name: "אורח שני", seat_kind: "adult" },
    ]);
  });

  it("combines members, children and guest names, in that order", () => {
    expect(buildAddPassengerInputs(["m1"], ["c1"], "אורח", members, children)).toEqual([
      { person_id: "m1", display_name: "Alice", seat_kind: "adult" },
      { child_id: "c1", display_name: "Kid Young", seat_kind: "child_seat" },
      { display_name: "אורח", seat_kind: "adult" },
    ]);
  });

  it("falls back to an empty display name for an id no longer found in the candidate list", () => {
    expect(buildAddPassengerInputs(["missing"], [], "", members, children)).toEqual([
      { person_id: "missing", display_name: "", seat_kind: "adult" },
    ]);
  });
});
