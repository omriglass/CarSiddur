import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { RULE_ORDER, ruleColor, ruleHow, ruleName, ruleSlices } from "./ruleExplain";

describe("ruleSlices (REQ §13.133)", () => {
  it("keeps the fixed rule order, drops zero weights, and shares sum to one", () => {
    const slices = ruleSlices([
      { type: "fairness", weight: 2, params: {} },
      { type: "rideType", weight: 3, params: {} },
      { type: "distance", weight: 0, params: {} },
    ]);
    expect(slices.map((s) => s.rule.type)).toEqual(["rideType", "fairness"]);
    expect(slices.map((s) => s.fraction)).toEqual([0.6, 0.4]);
    expect(slices[1]!.start).toBeCloseTo(0.6);
    expect(slices[1]!.end).toBeCloseTo(1);
  });
});

describe("ruleColor", () => {
  it("gives each rule type its own fixed slot, whatever else the policy holds", () => {
    expect(RULE_ORDER.map(ruleColor)).toEqual(RULE_ORDER.map((_, i) => `var(--chart-${i + 1})`));
    expect(ruleColor("somethingNew")).toBe("hsl(var(--muted-foreground))");
  });
});

describe("ruleHow", () => {
  it("fills in the policy's own numbers", () => {
    expect(ruleHow({ type: "distance", params: { maxKm: 80 } }, {})).toContain("80");
    expect(ruleHow({ type: "fairness", params: { lookbackWeeks: 4, alternativeServedWeight: 0.2 } }, {})).toMatch(/4.*0\.2/s);
  });

  it("names ride types by their names, highest weight first", () => {
    const text = ruleHow({ type: "rideType", params: { weights: { other: 2, health: 9 }, defaultWeight: 5 } }, { health: "Health", other: "Other" });
    expect(text.indexOf("Health 9")).toBeLessThan(text.indexOf("Other 2"));
  });

  it("falls back to the rule's defaults for invalid params, and explains an unknown rule", () => {
    expect(ruleHow({ type: "peopleServed", params: { cap: -1 } }, {})).toContain("4");
    expect(ruleHow({ type: "mystery", params: {} }, {})).toBe(he.policyView.how.unknown);
    expect(ruleName("mystery")).toContain("mystery");
  });
});
