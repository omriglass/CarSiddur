import { describe, expect, it } from "vitest";

import { weekPlacesKey } from "./weekPlacesKey";

const request = (origin: string | null, destination: string | null, stops: string[] = []) => ({
  origin_id: origin, destination_id: destination, stops: stops.map((place_id) => ({ place_id })),
});

describe("weekPlacesKey", () => {
  it("ignores order and repeats", () => {
    expect(weekPlacesKey([request("a", "b"), request("b", "c")])).toBe(weekPlacesKey([request("c", "b"), request("a", null, ["b"])]));
  });

  it("changes when a new place appears, including a stop", () => {
    const base = weekPlacesKey([request("a", "b")]);
    expect(weekPlacesKey([request("a", "b"), request("a", "c")])).not.toBe(base);
    expect(weekPlacesKey([request("a", "b", ["d"])])).not.toBe(base);
  });
});
