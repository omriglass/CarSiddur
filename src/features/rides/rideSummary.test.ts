import { describe, expect, it } from "vitest";

import type { RoutePoint } from "@/lib/rideRoute";

import { namesList, rideSummaryText } from "./rideSummary";
import type { StopRow } from "./rideStretches";

// Owner 2026-11-16, the Wednesday ride to בנימינה.
const point = (leg: "out" | "return", position: number, name: string): RoutePoint =>
  ({ leg, position, placeId: name, placeText: null, name, requestId: "q1", kind: "stop", eta: null });
const row = (leg: "out" | "return", position: number, name: string, off: string[], on: string[]): StopRow =>
  ({ leg, first: position === 0, point: point(leg, position, name), off, on, free: null });

describe("rideSummaryText", () => {
  it("names a list the Hebrew way", () => {
    expect(namesList(["נועה"])).toBe("נועה");
    expect(namesList(["נועה", "עידו"])).toBe("נועה ועידו");
    expect(namesList(["נועה", "עידו", "דנה"])).toBe("נועה, עידו ודנה");
  });

  it("the places in the middle of each way, in words", () => {
    const rows = [
      row("out", 0, "נבו", [], ["חבר", "נועה", "עידו"]),
      row("out", 1, "זכרון יעקב", ["נועה", "עידו"], ["דנה"]),
      row("out", 2, "בנימינה", ["חבר", "דנה"], []),
      row("return", 0, "בנימינה", [], ["חבר", "דנה"]),
      row("return", 1, "זכרון יעקב", [], ["נועה", "עידו"]),
      row("return", 2, "נבו", ["חבר", "דנה", "נועה", "עידו"], []),
    ];
    expect(rideSummaryText("חבר וסדרן לבנימינה", rows)).toBe(
      "חבר וסדרן לבנימינה, עוברים בזכרון יעקב להוריד את נועה ועידו ולאסוף את דנה. בחזור עוברים בזכרון יעקב לאסוף את נועה ועידו.");
  });

  it("only the way back has a place in the middle; nothing in the middle at all", () => {
    const back = [row("return", 0, "חיפה", [], []), row("return", 1, "קיסריה", [], []), row("return", 2, "נבו", [], [])];
    expect(rideSummaryText("סדרן לחיפה", back)).toBe("סדרן לחיפה. בחזור עוברים בקיסריה.");
    expect(rideSummaryText("סדרן לחיפה", [])).toBe("סדרן לחיפה");
  });
});
