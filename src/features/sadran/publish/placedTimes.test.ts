import { describe, expect, it } from "vitest";

import { placedTimes } from "./placedTimes";
import type { BoardRide } from "../api";

const request = { id: "r1", depart_at: "2026-10-12T05:00:00.000Z", return_at: "2026-10-12T09:00:00.000Z" };

describe("placedTimes (R3B19)", () => {
  it("uses the serving ride's times, not the requested ones", () => {
    const ride = { id: "a", status: "confirmed", starts_at: "2026-10-12T06:00:00.000Z", ends_at: "2026-10-12T10:00:00.000Z", served: [{ request_id: "r1", role: "driver", leg: "both" }] } as unknown as BoardRide;
    expect(placedTimes(request, [ride])).toEqual({ departAt: "2026-10-12T06:00:00.000Z", returnAt: "2026-10-12T10:00:00.000Z" });
  });
  it("falls back to the requested times when no ride serves it", () => {
    expect(placedTimes(request, [])).toEqual({ departAt: request.depart_at, returnAt: request.return_at });
  });
});
