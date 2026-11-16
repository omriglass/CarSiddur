import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { tv } from "@/i18n/he";

import type { RidePerson } from "../ridePeople";
import { RidePassengersList } from "./RidePassengersList";

vi.mock("../hooks", () => ({
  useRemoveRidePassengerMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useSetRidePersonPartMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useRideStretchesQuery: () => ({ data: undefined }),
}));

const person = (key: string, source: RidePerson["source"], name: string): RidePerson => ({
  key, source, request_id: null, ride_passenger_id: null, person_id: null, child_id: null,
  display_name: name, seat_kind: "adult", added_by: null, removable: source !== "driver", leg: "both",
});
const people = [
  person("driver:d", "driver", "דנה"), person("req:r2", "requester", "גיל"), person("comp:r2:p", "companion", "רותי"),
  person("child:r2:c", "child", "נועם"), person("added:a", "added", "אורח"),
];
const xFor = (name: string) => screen.queryByRole("button", { name: tv("addPassengers.removeAriaLabel", { name }) });
const editFor = (name: string) => screen.queryByRole("button", { name: tv("addPassengers.editAriaLabel", { name }) });
const route = [
  { leg: "out", position: 0, place_id: "a", kind: "origin", name: "נבו", request_id: "r2", eta: null },
  { leg: "out", position: 1, place_id: "b", kind: "destination", name: "חיפה", request_id: "r2", eta: null },
];

describe("RidePassengersList on a merged ride (owner 2026-11-09)", () => {
  it("requester and companion rows have no ✕; children and added people keep it", () => {
    render(<RidePassengersList rideId="r" expectedVersion={1} people={people} served={[]} canManagePeople requestRowsLocked />);
    expect(xFor("גיל")).toBeNull();
    expect(xFor("רותי")).toBeNull();
    expect(xFor("נועם")).not.toBeNull();
    expect(xFor("אורח")).not.toBeNull();
  });

  it("an ordinary ride keeps every ✕ but the driver's", () => {
    render(<RidePassengersList rideId="r" expectedVersion={1} people={people} served={[]} canManagePeople />);
    expect(xFor("דנה")).toBeNull();
    for (const name of ["גיל", "רותי", "נועם", "אורח"]) expect(xFor(name)).not.toBeNull();
  });

  // REQ item 246 h: with the ride's route, a companion / child / added person is edited by tapping the row (no ✕ -
  // "הסרה מהנסיעה" is inside); the requester keeps the ✕, the driver has neither.
  it("tap a name to edit: the whole row, no separate ✕", () => {
    render(<RidePassengersList rideId="r" expectedVersion={1} people={people} served={[]} canManagePeople route={route} />);
    for (const name of ["רותי", "נועם", "אורח"]) {
      expect(editFor(name)).not.toBeNull();
      expect(xFor(name)).toBeNull();
    }
    expect(editFor("גיל")).toBeNull();
    expect(xFor("גיל")).not.toBeNull();
    expect(editFor("דנה")).toBeNull();
  });
});
