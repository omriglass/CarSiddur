// src/solver/rules/publicTransport.ts
import { ruleDescription } from '../reasons';
import type { Rule } from './types';

export type PublicTransportParams = Record<string, never>;

export const publicTransport: Rule<PublicTransportParams> = {
  type: 'publicTransport',
  normalization: 'unit',
  defaultParams: {},
  validateParams() {
    return {};
  },
  describe() {
    return ruleDescription('RULE_PUBLICTRANSPORT_DESC');
  },
  score(ctx, request) {
    const dest = ctx.destinations[request.destinationId];
    const score = dest?.publicTransportScore;
    if (score === undefined) return 0.5;
    return 1 - score;
  },
};
