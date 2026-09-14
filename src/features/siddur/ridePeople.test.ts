import { describe, expect, it } from "vitest";

import { canRemoveRidePerson, freeSeats, peopleNames, peopleOf, peopleSeatLoad, type RidePerson } from "./ridePeople";

function person(overrides: Partial<RidePerson> & Pick<RidePerson, "key" | "source" | "display_name">): RidePerson {
  return {
    request_id: null,
    ride_passenger_id: null,
    person_id: null,
    child_id: null,
    seat_kind: "adult",
    added_by: null,
    removable: true,
    ...overrides,
  };
}

const driver = person({ key: "driver:d1", source: "driver", display_name: "עומרי", person_id: "d1", removable: false });
const requester = person({ key: "req:r1", source: "requester", display_name: "דנה", person_id: "p1", request_id: "r1" });
const child = person({ key: "child:r1:c1", source: "child", display_name: "ילד קטן", child_id: "c1", request_id: "r1", seat_kind: "child_seat" });
const added = person({ key: "added:rp1", source: "added", display_name: "אורח", ride_passenger_id: "rp1", added_by: "p1" });

describe("peopleOf", () => {
  it("parses a valid people jsonb array", () => {
    expect(peopleOf({ people: [driver, requester] })).toEqual([driver, requester]);
  });

  it("returns an empty array when people is null or not an array", () => {
    expect(peopleOf({ people: null })).toEqual([]);
    expect(peopleOf({ people: "garbage" as unknown as never })).toEqual([]);
  });

  it("drops malformed entries instead of throwing", () => {
    expect(peopleOf({ people: [driver, { not: "a person" }] as unknown as never[] })).toEqual([driver]);
  });
});

describe("peopleNames", () => {
  it("lists every name in order by default", () => {
    expect(peopleNames([driver, requester, child, added])).toEqual(["עומרי", "דנה", "ילד קטן", "אורח"]);
  });

  it("excludes the driver when asked", () => {
    expect(peopleNames([driver, requester], { excludeDriver: true })).toEqual(["דנה"]);
  });

  it("drops blank display names", () => {
    expect(peopleNames([person({ key: "guest:r1:0", source: "guest", display_name: "  " })])).toEqual([]);
  });
});

describe("peopleSeatLoad", () => {
  it("sums seat_kind across the whole list, driver included", () => {
    expect(peopleSeatLoad([driver, requester, child, added])).toEqual({ adults: 3, childSeats: 1, boosters: 0 });
  });

  it("excludes the driver's seat when asked", () => {
    expect(peopleSeatLoad([driver, requester], { excludeDriver: true })).toEqual({ adults: 1, childSeats: 0, boosters: 0 });
  });

  it("counts boosters separately from child seats", () => {
    const booster = person({ key: "child:r1:c2", source: "child", display_name: "ילד גדול", seat_kind: "booster" });
    expect(peopleSeatLoad([booster])).toEqual({ adults: 0, childSeats: 0, boosters: 1 });
  });
});

describe("freeSeats", () => {
  it("subtracts adult seat load (driver included) from the car's adult capacity", () => {
    expect(freeSeats([driver, requester], { adults: 4, child_seats: 2, boosters: 0 })).toBe(2);
  });

  it("never goes negative", () => {
    expect(freeSeats([driver, requester, added], { adults: 1, child_seats: 0, boosters: 0 })).toBe(0);
  });
});

describe("canRemoveRidePerson", () => {
  it("refuses the driver even when the caller manages the week", () => {
    expect(canRemoveRidePerson(driver, { canManagePeople: true, rideCancelled: false })).toBe(false);
  });

  it("allows a removable entry when the caller may manage people and the ride is live", () => {
    expect(canRemoveRidePerson(added, { canManagePeople: true, rideCancelled: false })).toBe(true);
  });

  it("refuses when the caller cannot manage this ride's people", () => {
    expect(canRemoveRidePerson(added, { canManagePeople: false, rideCancelled: false })).toBe(false);
  });

  it("refuses on a cancelled ride even for an otherwise-removable entry", () => {
    expect(canRemoveRidePerson(added, { canManagePeople: true, rideCancelled: true })).toBe(false);
  });
});
