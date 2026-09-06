// src/solver/rules/peopleServed.ts
import { ruleDescription } from '../reasons';
import { PolicyParamsError } from '../types';
import type { Rule } from './types';

export interface PeopleServedParams {
  cap: number;
}

export const peopleServed: Rule<PeopleServedParams> = {
  type: 'peopleServed',
  normalization: 'unit',
  defaultParams: { cap: 4 },
  validateParams(raw) {
    if (typeof raw !== 'object' || raw === null || !('cap' in raw)) throw new PolicyParamsError('PEOPLESERVED_CAP_INVALID');
    const cap = (raw as { cap: unknown }).cap;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
      throw new PolicyParamsError('PEOPLESERVED_CAP_INVALID');
    }
    return { cap };
  },
  describe() {
    return ruleDescription('RULE_PEOPLESERVED_DESC');
  },
  score(ctx, request) {
    const paired = ctx.batch.relayPairPeople?.get(request.id);
    const people =
      paired ??
      request.passengers.adults + request.passengers.childSeats + request.passengers.boosters - 1;
    return Math.min(Math.max(people, 0) / ctx.params.cap, 1);
  },
};
