// src/solver/rules/index.ts
//
// The rule registry (docs/SOLVER.md §4.1, §4.5). Adding a rule type means
// creating src/solver/rules/<type>.ts and adding one line here — see
// .claude/skills/add-priority-rule and src/solver/README.md.

import { distance } from './distance';
import { fairness } from './fairness';
import { flexibilityOffered } from './flexibilityOffered';
import { manualBoost } from './manualBoost';
import { peopleServed } from './peopleServed';
import { publicTransport } from './publicTransport';
import { rideType } from './rideType';
import { submissionTime } from './submissionTime';
import type { Rule } from './types';

export const ruleRegistry = {
  rideType,
  distance,
  publicTransport,
  peopleServed,
  fairness,
  submissionTime,
  flexibilityOffered,
  manualBoost,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Rule<P> registry, see SOLVER.md §4.1
} as const satisfies Record<string, Rule<any>>;

export type RuleType = keyof typeof ruleRegistry;

export type { Rule, RuleContext } from './types';
export { distance, fairness, flexibilityOffered, manualBoost, peopleServed, publicTransport, rideType, submissionTime };
