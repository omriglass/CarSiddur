import { describe, expect, it } from "vitest";
import type { BoardRide, WeekRequestRow } from "../api";
import { requestDeviations } from "./requestDeviations";

const request = { id: "q", status: "assigned", original_depart_at: "2040-01-01T07:15:00Z", depart_at: "2040-01-01T07:00:00Z",
  original_return_at: "2040-01-01T10:00:00Z", return_at: "2040-01-01T10:00:00Z", preferred_car_id: "preferred" } as unknown as WeekRequestRow;
const ride = { id: "r", car_id: "other", status: "confirmed", needs_driver: false, starts_at: "2040-01-01T07:00:00Z", ends_at: "2040-01-01T10:00:00Z",
  served: [{ request_id: "q", role: "driver", leg: "both", car_mode: "keep" }] } as unknown as BoardRide;
describe("request deviations", () => {
  it("retains a coordinator time deviation after the request itself has been shifted", () => {
    expect(requestDeviations([request], [ride])[0]?.changes).toEqual([
      { kind: "depart", original: request.original_depart_at, current: ride.starts_at, rideId: "r" },
      { kind: "preferredCar", original: "preferred", current: "other", rideId: "r" },
    ]);
  });
  it("compares a return passenger's arrival, not the chauffeur's earlier deadhead departure", () => {
    const passenger = { ...request, original_depart_at: null, depart_at: null, preferred_car_id: null };
    const chauffeur = { ...ride, needs_driver: true, served: [{ request_id: "q", role: "passenger", leg: "return", car_mode: "chauffeur" }] };
    expect(requestDeviations([passenger], [chauffeur])[0]?.changes).toEqual([{ kind: "missingDriver", rideId: "r" }]);
  });
  it("shows unassigned requests but excludes drafts/withdrawals and cancelled assignments", () => {
    expect(requestDeviations([{ ...request, status: "submitted" }], [{ ...ride, status: "cancelled" }])[0]?.changes).toEqual([{ kind: "unassigned" }]);
    expect(requestDeviations([{ ...request, status: "draft" }, { ...request, status: "withdrawn" }], [])).toEqual([]);
  });
  it("does not flag equal instants represented with different timezone offsets", () => {
    expect(requestDeviations([{ ...request, original_depart_at: "2040-01-01T09:00:00+02:00", preferred_car_id: null }], [ride])).toEqual([]);
  });
});
