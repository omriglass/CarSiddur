// src/solver/policy/engine.ts
//
// scoreRequests(): Sigma weight * normalized(rule value) (docs/SOLVER.md §4.2).
// Unknown rule types warn (UNKNOWN_RULE_TYPE) and are skipped, never a crash
// — the policy is data and may be newer than the code. Determinism: rule
// values are rounded to 6 decimals and summed in rule-registry order.

import { reason } from '../reasons';
import { ruleRegistry } from '../rules/index';
import type { Rule, RuleContext } from '../rules/types';
import type { NormalizedRequest, Warning } from '../slots';
import { PolicyParamsError, type SolverInput } from '../types';

export interface ScoreBreakdown {
  total: number;
  perRule: { type: string; raw: number; normalized: number; weight: number; contribution: number }[];
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Rule<P> lookup
const registry = ruleRegistry as Record<string, Rule<any>>;
const registryOrder = Object.keys(ruleRegistry);

export interface ScoreResult {
  scores: Map<string, ScoreBreakdown>;
  warnings: Warning[];
}

export function scoreRequests(
  input: SolverInput,
  batch: NormalizedRequest[],
  relayPairPeople?: Map<string, number>,
): ScoreResult {
  const warnings: Warning[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Rule<P> params per entry
  const active: { type: string; weight: number; rule: Rule<any>; params: any }[] = [];

  for (const rc of input.policy.rules) {
    const rule = registry[rc.type];
    if (!rule) {
      warnings.push({ code: 'UNKNOWN_RULE_TYPE', message: reason('WARN_UNKNOWN_RULE_TYPE'), requestId: undefined });
      continue;
    }
    try {
      const params = rule.validateParams(rc.params);
      active.push({ type: rc.type, weight: rc.weight, rule, params });
    } catch (e) {
      const code = e instanceof PolicyParamsError ? e.reasonCode : 'UNKNOWN_RULE_TYPE';
      warnings.push({ code, message: reason(code), requestId: undefined });
    }
  }

  // Sum in rule-registry order (determinism, SOLVER §3.14), not policy-authoring order.
  active.sort((a, b) => registryOrder.indexOf(a.type) - registryOrder.indexOf(b.type));

  const rawByRule = new Map<string, Map<string, number>>();
  for (const { type, rule, params } of active) {
    const ctx: RuleContext<unknown> = {
      params,
      policy: input.policy,
      stats: input.stats,
      destinations: input.destinations,
      batch: { requests: batch, size: batch.length, relayPairPeople },
    };
    const values = new Map<string, number>();
    for (const nr of batch) values.set(nr.id, round6(rule.score(ctx, nr)));
    rawByRule.set(type, values);
  }

  const scores = new Map<string, ScoreBreakdown>();
  for (const nr of batch) {
    const perRule: ScoreBreakdown['perRule'] = [];
    let total = 0;
    for (const { type, weight, rule } of active) {
      const rawMap = rawByRule.get(type);
      const raw = rawMap?.get(nr.id) ?? 0;
      let normalized: number;
      if (rule.normalization === 'unit') {
        normalized = clamp01(raw);
      } else {
        const all = rawMap ? [...rawMap.values()] : [0];
        const min = Math.min(...all);
        const max = Math.max(...all);
        normalized = max === min ? 0 : clamp01((raw - min) / (max - min));
      }
      const contribution = round6(weight * normalized);
      total = round6(total + contribution);
      perRule.push({ type, raw, normalized, weight, contribution });
    }
    scores.set(nr.id, { total, perRule });
  }

  return { scores, warnings };
}
