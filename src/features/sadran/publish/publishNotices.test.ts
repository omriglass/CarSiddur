import { describe, expect, it } from "vitest";

import type { BoardRide } from "../api";
import { publishNotices } from "./publishNotices";

const ride = (id: string, requestId: string, starts = "2026-10-26T06:00:00Z", extra: Partial<BoardRide> = {}) =>
  ({ id, starts_at: starts, ends_at: "2026-10-26T08:00:00Z", car_id: "car", driver_id: "d", status: "confirmed",
     served: [{ request_id: requestId, leg: "both" }], ...extra }) as unknown as BoardRide;
const req = (id: string, requester: string, status: string, day = "2026-10-26") => ({ id, requester_id: requester, status, day });

describe("publishNotices (R13U3/R13U9: the people a publish tells, one notice each)", () => {
  it("first publish: placed, waiting and lapsing-offer requests are told; one entry per person", () => {
    const result = publishNotices({
      requests: [req("a", "m1", "assigned"), req("b", "m1", "waitlisted"), req("c", "m2", "proposed"), req("d", "m3", "denied"), req("e", "m4", "withdrawn")],
      rides: [ride("r1", "a")], priorPublishedDays: null, previousStatuses: new Map(), previousRides: [],
      lapsingRequestIds: new Set(["c"]),
    });
    expect(result.notified.map((n) => [n.requesterId, n.requests.map((r) => r.id)])).toEqual([["m1", ["a", "b"]], ["m2", ["c"]]]);
    expect(result.unnotifiedCount).toBe(1); // the denied one; the withdrawn one is not counted at all
  });

  it("a day published again tells only what changed since the last version (R13U3: not every request)", () => {
    const result = publishNotices({
      requests: [req("a", "m1", "assigned"), req("b", "m2", "assigned"), req("c", "m3", "waitlisted")],
      rides: [ride("r1", "a"), ride("r2", "b", "2026-10-26T06:30:00Z")],
      priorPublishedDays: ["2026-10-26"],
      previousStatuses: new Map([["a", "assigned"], ["b", "assigned"], ["c", "waitlisted"]]),
      previousRides: [
        { id: "r1", starts_at: "2026-10-26T06:00:00+00:00", ends_at: "2026-10-26T08:00:00+00:00", car_id: "car", driver_id: "d" },
        { id: "r2", starts_at: "2026-10-26T06:00:00+00:00", ends_at: "2026-10-26T08:00:00+00:00", car_id: "car", driver_id: "d" },
      ],
      lapsingRequestIds: new Set(),
    });
    expect(result.notified.map((n) => n.requesterId)).toEqual(["m2"]);
    expect(result.unnotifiedCount).toBe(2);
  });
});
