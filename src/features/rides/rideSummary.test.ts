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

  it("RP1: who rides from where to where, each way one sentence (the owner's example)", () => {
    const rows = [
      row("out", 0, "נבו", [], ["חבר ראשון", "ענבר"]),
      row("out", 1, "זכרון יעקב", [], []),
      row("out", 2, "בנימינה", ["חבר ראשון", "ענבר"], []),
      row("return", 0, "בנימינה", [], ["חבר ראשון", "נגה"]),
      row("return", 1, "נבו", ["חבר ראשון", "נגה"], []),
    ];
    expect(rideSummaryText("חבר לבנימינה", rows, "נבו")).toBe("חבר וענבר לבנימינה דרך זכרון יעקב. בחזור: חבר ונגה מבנימינה הביתה.");
    // without the home place: the way back says where it ends
    expect(rideSummaryText("חבר לבנימינה", rows)).toBe("חבר וענבר לבנימינה דרך זכרון יעקב. בחזור: חבר ונגה מבנימינה לנבו.");
  });

  it("people getting on / off in the middle each get their own part, the longest first", () => {
    const rows = [
      row("out", 0, "נבו", [], ["חבר", "נועה", "עידו"]),
      row("out", 1, "זכרון יעקב", ["נועה", "עידו"], ["דנה"]),
      row("out", 2, "בנימינה", ["חבר", "דנה"], []),
      row("return", 0, "בנימינה", [], ["חבר", "דנה"]),
      row("return", 1, "זכרון יעקב", [], ["נועה", "עידו"]),
      row("return", 2, "נבו", ["חבר", "דנה", "נועה", "עידו"], []),
    ];
    expect(rideSummaryText("חבר וסדרן לבנימינה", rows, "נבו")).toBe(
      "חבר לבנימינה דרך זכרון יעקב; נועה ועידו לזכרון יעקב; דנה מזכרון יעקב לבנימינה. "
      + "בחזור: חבר ודנה מבנימינה הביתה דרך זכרון יעקב; נועה ועידו מזכרון יעקב הביתה.");
  });

  it("nothing to explain keeps the label; a way back only; two people with one first name", () => {
    const same = [
      row("out", 0, "נבו", [], ["דנה"]), row("out", 1, "בנימינה", ["דנה"], []),
      row("return", 0, "בנימינה", [], ["דנה"]), row("return", 1, "נבו", ["דנה"], []),
    ];
    expect(rideSummaryText("דנה לבנימינה", same, "נבו")).toBe("דנה לבנימינה");
    expect(rideSummaryText("סדרן לחיפה", [], "נבו")).toBe("סדרן לחיפה");
    const back = [row("return", 0, "חיפה", [], ["סדרן"]), row("return", 1, "קיסריה", [], []), row("return", 2, "נבו", ["סדרן"], [])];
    expect(rideSummaryText("סדרן מחיפה", back, "נבו")).toBe("סדרן מחיפה הביתה דרך קיסריה.");
    const twins = [
      row("out", 0, "נבו", [], ["דנה כהן", "דנה לוי"]), row("out", 1, "בנימינה", ["דנה כהן", "דנה לוי"], []),
      row("return", 0, "בנימינה", [], ["דנה כהן"]), row("return", 1, "נבו", ["דנה כהן"], []),
    ];
    expect(rideSummaryText("x", twins, "נבו")).toBe("דנה כהן ודנה לוי לבנימינה. בחזור: דנה כהן מבנימינה הביתה.");
  });
});
