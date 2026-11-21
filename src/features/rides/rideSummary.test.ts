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

  it("RP1: each way as a flow (the owner's example)", () => {
    const rows = [
      row("out", 0, "נבו", [], ["חבר ראשון", "ענבר"]),
      row("out", 1, "זכרון יעקב", [], []),
      row("out", 2, "בנימינה", ["חבר ראשון", "ענבר"], []),
      row("return", 0, "בנימינה", [], ["חבר ראשון", "נגה"]),
      row("return", 1, "נבו", ["חבר ראשון", "נגה"], []),
    ];
    expect(rideSummaryText("חבר לבנימינה", rows, "נבו")).toBe(
      "חבר וענבר יוצאים מהבית, עוברים בזכרון יעקב וממשיכים לבנימינה. בחזור: חבר ונגה יוצאים מבנימינה הביתה.");
    // without the home place: its name
    expect(rideSummaryText("חבר לבנימינה", rows)).toBe(
      "חבר וענבר יוצאים מנבו, עוברים בזכרון יעקב וממשיכים לבנימינה. בחזור: חבר ונגה יוצאים מבנימינה לנבו.");
  });

  it("people left and picked up on the way", () => {
    const rows = [
      row("out", 0, "נבו", [], ["חבר", "טל", "גל"]),
      row("out", 1, "זכרון יעקב", ["גל"], []),
      row("out", 2, "בנימינה", ["חבר", "טל"], []),
      row("return", 0, "בנימינה", [], ["חבר", "טל"]),
      row("return", 1, "זכרון יעקב", [], ["גל"]),
      row("return", 2, "נבו", ["חבר", "טל", "גל"], []),
    ];
    expect(rideSummaryText("חבר לבנימינה", rows, "נבו")).toBe(
      "חבר, טל וגל יוצאים מהבית, משאירים את גל בזכרון יעקב וממשיכים לבנימינה. "
      + "בחזור: חבר וטל יוצאים מבנימינה, אוספים את גל מזכרון יעקב וממשיכים הביתה.");
    const swap = [
      row("out", 0, "נבו", [], ["חבר", "נועה"]),
      row("out", 1, "זכרון יעקב", ["נועה"], ["דנה"]),
      row("out", 2, "בנימינה", ["חבר", "דנה"], []),
    ];
    expect(rideSummaryText("x", swap, "נבו", "out")).toBe(
      "חבר ונועה יוצאים מהבית, משאירים את נועה בזכרון יעקב ואוספים את דנה וממשיכים לבנימינה · הלוך בלבד.");
  });

  it("a simple ride keeps its label; one way says so; one person; two people with one first name", () => {
    const same = [
      row("out", 0, "נבו", [], ["דנה"]), row("out", 1, "בנימינה", ["דנה"], []),
      row("return", 0, "בנימינה", [], ["דנה"]), row("return", 1, "נבו", ["דנה"], []),
    ];
    expect(rideSummaryText("דנה לבנימינה", same, "נבו")).toBe("דנה לבנימינה");
    expect(rideSummaryText("סדרן לחיפה", [], "נבו")).toBe("סדרן לחיפה");
    expect(rideSummaryText("סדרן לחיפה", [], "נבו", "out")).toBe("סדרן לחיפה · הלוך בלבד");
    const back = [row("return", 0, "חיפה", [], ["סדרן"]), row("return", 1, "קיסריה", [], []), row("return", 2, "נבו", ["סדרן"], [])];
    expect(rideSummaryText("סדרן מחיפה", back, "נבו", "return")).toBe("סדרן יוצא/ת מחיפה, עובר/ת בקיסריה וממשיך/ה הביתה · חזור בלבד.");
    const twins = [
      row("out", 0, "נבו", [], ["דנה כהן", "דנה לוי"]), row("out", 1, "בנימינה", ["דנה כהן", "דנה לוי"], []),
      row("return", 0, "בנימינה", [], ["דנה כהן"]), row("return", 1, "נבו", ["דנה כהן"], []),
    ];
    expect(rideSummaryText("x", twins, "נבו")).toBe("דנה כהן ודנה לוי יוצאים מהבית לבנימינה. בחזור: דנה כהן יוצא/ת מבנימינה הביתה.");
  });
});
