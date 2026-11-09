import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { tv } from "@/i18n/he";

import type { RidePerson } from "../ridePeople";
import { RidePassengersList } from "./RidePassengersList";

vi.mock("../hooks", () => ({ useRemoveRidePassengerMutation: () => ({ mutate: vi.fn(), isPending: false }) }));

const person = (key: string, source: RidePerson["source"], name: string): RidePerson => ({
  key, source, request_id: null, ride_passenger_id: null, person_id: null, child_id: null,
  display_name: name, seat_kind: "adult", added_by: null, removable: source !== "driver", leg: "both",
});
const people = [
  person("driver:d", "driver", "דנה"), person("req:r2", "requester", "גיל"), person("comp:r2:p", "companion", "רותי"),
  person("child:r2:c", "child", "נועם"), person("added:a", "added", "אורח"),
];
const xFor = (name: string) => screen.queryByRole("button", { name: tv("addPassengers.removeAriaLabel", { name }) });

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
});
