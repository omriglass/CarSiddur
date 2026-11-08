import { describe, expect, it } from "vitest";

import { buildPersonBlocks, flexPairText, intervalMinutes, needsPersonBlocks } from "./ridePersonBlocks";
import type { ServedEntry } from "./servedOf";

function entry(over: Partial<ServedEntry> & { request_id: string }): ServedEntry {
  return { role: "passenger", leg: "both", car_mode: "keep", adults: 1, child_seats: 0, boosters: 0, luggage: false, ...over };
}

const person = (over: Record<string, unknown>) => ({
  key: "k", source: "requester", request_id: null, ride_passenger_id: null, person_id: null, child_id: null,
  display_name: "x", seat_kind: "adult", added_by: null, removable: true, ...over,
});

describe("intervalMinutes", () => {
  it("reads postgres interval text", () => {
    expect(intervalMinutes("00:30:00")).toBe(30);
    expect(intervalMinutes("1 day")).toBe(1440);
    expect(intervalMinutes("2 hours")).toBe(120);
    expect(intervalMinutes(null)).toBeNull();
  });
});

describe("flexPairText", () => {
  it("is empty without flexibility", () => {
    expect(flexPairText(0, null)).toBe("");
  });
  it("is symmetric or split", () => {
    expect(flexPairText(30, 30)).toContain("½");
    expect(flexPairText(30, 0)).not.toContain("/");
    expect(flexPairText(30, 15)).toContain("/");
  });
});

describe("needsPersonBlocks", () => {
  it("is false for one plain request", () => {
    expect(needsPersonBlocks({ people: [person({ source: "requester", request_id: "a" })] as never }, [entry({ request_id: "a" })])).toBe(false);
  });
  it("is true for two requests or an added person", () => {
    expect(needsPersonBlocks({ people: [] }, [entry({ request_id: "a" }), entry({ request_id: "b" })])).toBe(true);
    expect(needsPersonBlocks({ people: [person({ source: "added" })] as never }, [entry({ request_id: "a" })])).toBe(true);
  });
});

describe("buildPersonBlocks", () => {
  const ride = {
    starts_at: "2026-11-10T05:00:00Z",
    driver_id: null, driver_name: null, needs_driver: false,
    route: [
      { leg: "out", position: 0, place_id: "o", place_text: null, name: "נבו", request_id: null, kind: "origin", eta: null },
      { leg: "out", position: 1, place_id: "s", place_text: null, name: "מקום ביניים", request_id: "b", kind: "board", eta: null },
      { leg: "out", position: 2, place_id: "d", place_text: null, name: "עיר", request_id: null, kind: "destination", eta: null },
    ],
    people: [
      person({ key: "d", source: "driver", request_id: "a", display_name: "א" }),
      person({ key: "g", source: "guest", request_id: "b", display_name: "אורח" }),
      person({ key: "p", source: "added", display_name: "מוסיף", leg: "out" }),
    ],
  } as never;
  const served = [
    entry({ request_id: "b", requester: "ב", destination: "עיר", origin_name: "נבו", tow_hitch: true }),
    entry({ request_id: "a", role: "driver", requester: "א", destination: "עיר", origin_name: "נבו", adults: 2, luggage: true }),
  ];

  it("lists the driver first, then riders, then added people", () => {
    const blocks = buildPersonBlocks({ ride, served });
    expect(blocks.map((b) => [b.name, b.role])).toEqual([["א", "driver"], ["ב", "rider"], ["מוסיף", "added"]]);
    expect(blocks[0]?.seats?.adults).toBe(2);
    expect(blocks[0]?.luggage).toBe(true);
    expect([blocks[0]?.tow, blocks[1]?.tow]).toEqual([false, true]);
    expect(blocks[1]?.withNames).toEqual(["אורח"]);
  });

  it("flags a later start and an extra route place", () => {
    const blocks = buildPersonBlocks({ ride, served, requests: new Map([["a", { departAt: "2026-11-10T05:30:00Z" }]]) });
    expect(blocks[0]?.differs).toHaveLength(2);
    expect(blocks[1]?.differs).toHaveLength(0);
  });

  it("shows no difference when the request matches the ride", () => {
    const blocks = buildPersonBlocks({ ride, served, requests: new Map([["b", { departAt: "2026-11-10T05:00:00Z" }]]) });
    expect(blocks[1]?.differs).toHaveLength(0);
  });
});
