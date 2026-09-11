// src/solver/rules/submissionTime.ts
import { ruleDescription } from '../reasons';
import type { Rule } from './types';
import { validatePositiveNumberParam } from './types';

export interface SubmissionTimeParams {
  latePenalty: number;
}

export const submissionTime: Rule<SubmissionTimeParams> = {
  type: 'submissionTime',
  normalization: 'unit',
  defaultParams: { latePenalty: 1 },
  validateParams(raw) {
    // latePenalty may legitimately be 0 (late submissions score like on-time ones).
    return {
      latePenalty: validatePositiveNumberParam(raw, 'latePenalty', 'SUBMISSIONTIME_LATEPENALTY_INVALID', { allowZero: true }),
    };
  },
  describe() {
    return ruleDescription('RULE_SUBMISSIONTIME_DESC');
  },
  score(ctx, request) {
    if (request.request.isLate) {
      return Math.max(0, 0.7 - ctx.params.latePenalty);
    }
    const n = Math.max(1, ctx.batch.size);
    const earlierCount = ctx.batch.requests.filter(
      (other) => other.request.submittedAtMs < request.request.submittedAtMs,
    ).length;
    return 1 - 0.3 * (earlierCount / n);
  },
};
