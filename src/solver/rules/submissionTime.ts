// src/solver/rules/submissionTime.ts
import { ruleDescription } from '../reasons';
import { PolicyParamsError } from '../types';
import type { Rule } from './types';

export interface SubmissionTimeParams {
  latePenalty: number;
}

export const submissionTime: Rule<SubmissionTimeParams> = {
  type: 'submissionTime',
  normalization: 'unit',
  defaultParams: { latePenalty: 1 },
  validateParams(raw) {
    if (typeof raw !== 'object' || raw === null || !('latePenalty' in raw)) {
      throw new PolicyParamsError('SUBMISSIONTIME_LATEPENALTY_INVALID');
    }
    const latePenalty = (raw as { latePenalty: unknown }).latePenalty;
    if (typeof latePenalty !== 'number' || !Number.isFinite(latePenalty) || latePenalty < 0) {
      throw new PolicyParamsError('SUBMISSIONTIME_LATEPENALTY_INVALID');
    }
    return { latePenalty };
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
