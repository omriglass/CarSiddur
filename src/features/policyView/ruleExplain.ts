// "הצג מדיניות" (REQ §13.133): how each rule of a policy reads for a member — name, one-line summary,
// "how it is calculated" with the policy's own parameters, a fixed color per rule type and its share
// of the maximum score. Pure. Rule names/summaries are the admin editor's (`adminPolicy.*`); the
// formulas mirror `src/solver/rules/*` (keep them in step when a rule's score() changes).
import { pieSegments } from "@/features/stats/pieMath";
import { he, tv } from "@/i18n/he";
import { ruleRegistry } from "@/solver/rules";

import type { ViewRule } from "./api";

/** Fixed slot per rule type ("color follows the entity, never its rank"): `--chart-1..8` in `index.css`. */
export const RULE_ORDER = [
  "rideType", "distance", "publicTransport", "peopleServed", "fairness", "submissionTime", "flexibilityOffered", "manualBoost",
] as const;
type KnownRule = (typeof RULE_ORDER)[number];

function isKnown(type: string): type is KnownRule {
  return (RULE_ORDER as readonly string[]).includes(type);
}

export function ruleColor(type: string): string {
  const slot = (RULE_ORDER as readonly string[]).indexOf(type);
  return slot >= 0 ? `var(--chart-${slot + 1})` : "hsl(var(--muted-foreground))";
}

export function ruleName(type: string): string {
  return isKnown(type) ? he.adminPolicy.ruleNames[type] : tv("policyView.unknownRule", { type });
}

export function ruleSummary(type: string): string {
  return isKnown(type) ? he.adminPolicy.ruleInfo[type] : "";
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** The rule's params as the solver reads them (defaults filled in); `null` for an unknown type or invalid params. */
function validParams(type: KnownRule, raw: unknown): Record<string, unknown> | null {
  try {
    return ruleRegistry[type].validateParams(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** "How it is calculated", with this policy's own numbers. `rideTypeNames` maps a ride-type code to its name. */
export function ruleHow(rule: Pick<ViewRule, "type" | "params">, rideTypeNames: Readonly<Record<string, string>>): string {
  if (!isKnown(rule.type)) return he.policyView.how.unknown;
  const params = validParams(rule.type, rule.params) ?? (ruleRegistry[rule.type].defaultParams as Record<string, unknown>);
  const num = (key: string) => formatNumber(Number(params[key] ?? 0));
  switch (rule.type) {
    case "rideType": {
      const weights = Object.entries((params.weights ?? {}) as Record<string, number>)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([code, weight]) => `${rideTypeNames[code] ?? code} ${formatNumber(weight)}`);
      const list = weights.length ? tv("policyView.rideTypeWeights", { list: weights.join(" · "), fallback: num("defaultWeight") }) : "";
      return tv("policyView.how.rideType", { weights: list }).trim();
    }
    case "distance":
      return tv("policyView.how.distance", { maxKm: num("maxKm") });
    case "peopleServed":
      return tv("policyView.how.peopleServed", { cap: num("cap") });
    case "fairness":
      return tv("policyView.how.fairness", { weeks: num("lookbackWeeks"), altWeight: num("alternativeServedWeight") });
    case "submissionTime":
      return tv("policyView.how.submissionTime", { latePenalty: num("latePenalty") });
    case "flexibilityOffered":
      return tv("policyView.how.flexibilityOffered", { minutes: num("fullCreditMinutes") });
    case "publicTransport":
    case "manualBoost":
      return he.policyView.how[rule.type];
  }
}

export interface RuleSlice {
  rule: ViewRule;
  /** Share of the maximum score (weight / Σ weights), `0..1`. */
  fraction: number;
  /** Where the slice starts/ends on the circle, `0..1` (consecutive, in `RULE_ORDER`). */
  start: number;
  end: number;
}

/** The policy's rules in their fixed order, each with its share of the weights; rules with no weight are left out. */
export function ruleSlices(rules: readonly ViewRule[]): RuleSlice[] {
  const rank = (type: string) => {
    const index = (RULE_ORDER as readonly string[]).indexOf(type);
    return index >= 0 ? index : RULE_ORDER.length;
  };
  const ordered = rules.filter((rule) => rule.weight > 0).sort((a, b) => rank(a.type) - rank(b.type) || a.type.localeCompare(b.type));
  const segments = pieSegments(ordered.map((rule) => rule.weight));
  return ordered.map((rule, index) => ({ rule, ...segments[index]! }));
}
